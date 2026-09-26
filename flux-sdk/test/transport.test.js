import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRelaySocketUrl } from '../dist/utils.js';
import { FluxClient } from '../dist/client.js';
import { SecureChannel } from '../dist/secure.js';

const LOCAL_TOKEN = 'instance-token';
const LOCAL_KEY_ID = 'key-1';

/**
 * Stands in for the instance's /api/secure endpoint: opens the envelope and seals the reply,
 * so the tests cover the real encrypted exchange rather than a mocked shortcut.
 */
function localInstance(handler) {
  const channel = new SecureChannel(LOCAL_TOKEN, LOCAL_KEY_ID);
  return async (init, calls) => {
    const { seq, request } = await channel.openRequest(new Uint8Array(init.body));
    calls.push({ path: request.path, query: request.query, method: request.method });
    const reply = await handler(request, seq);
    const sealed = await channel.sealResponse(seq, {
      status: reply.status ?? 200,
      headers: reply.headers ?? { 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify(reply.body ?? { ok: true })),
    });
    return new Response(sealed, { status: 200 });
  };
}

test('buildRelaySocketUrl converts relay HTTP URLs to the websocket endpoint', () => {
  assert.equal(
    buildRelaySocketUrl('https://relay.example.com', 'instance-a', 'ticket'),
    'wss://relay.example.com/ws?instance_id=instance-a&ws_ticket=ticket',
  );
});

test('buildRelaySocketUrl preserves an existing websocket path', () => {
  assert.equal(
    buildRelaySocketUrl('wss://relay.example.com/ws', 'instance-a', 'ticket'),
    'wss://relay.example.com/ws?instance_id=instance-a&ws_ticket=ticket',
  );
});

function baseConfig(overrides = {}) {
  return {
    relayUrl: 'https://relay.test',
    instanceId: 'instance-a',
    accessToken: LOCAL_TOKEN,
    keyId: LOCAL_KEY_ID,
    relaySession: 'relay-session',
    localBaseUrl: 'http://homeassistant.local:3589',
    localUseLan: true,
    autoConnect: false,
    ...overrides,
  };
}

test('favours the local instance when it is reachable', async () => {
  const calls = [];
  const serve = localInstance(() => ({ body: { ok: true } }));
  const client = new FluxClient(baseConfig({
    fetchImpl: async (input, init) => {
      const url = String(input);
      if (url === 'http://homeassistant.local:3589/api/secure') return await serve(init, calls);
      throw new Error(`Unexpected request: ${url}`);
    },
  }));

  const result = await client.getConfig();

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls, [{ path: '/api/config', query: {}, method: 'GET' }]);
  assert.equal(client.getTransportMode(), 'local');
});

test('never exposes the access token on the local network', async () => {
  let rawBody;
  const serve = localInstance(() => ({ body: { ok: true } }));
  const client = new FluxClient(baseConfig({
    fetchImpl: async (input, init) => {
      rawBody = new Uint8Array(init.body);
      assert.equal(init.headers['x-flux-key-id'], LOCAL_KEY_ID);
      assert.equal(init.headers.Authorization, undefined);
      return await serve(init, []);
    },
  }));

  await client.getConfig();

  const onTheWire = Buffer.from(rawBody).toString('latin1');
  assert.ok(!onTheWire.includes(LOCAL_TOKEN), 'access token must not appear in the envelope');
  assert.ok(!onTheWire.includes('/api/config'), 'request path must not be readable');
});

test('abandons the local transport when a response has been tampered with', async () => {
  const calls = [];
  const serve = localInstance(() => ({ body: { ok: true } }));
  const client = new FluxClient(baseConfig({
    fetchImpl: async (input, init) => {
      const url = String(input);
      calls.push(url);
      if (url === 'http://homeassistant.local:3589/api/secure') {
        const response = await serve(init, []);
        const bytes = new Uint8Array(await response.arrayBuffer());
        bytes[bytes.length - 1] ^= 0xff;
        return new Response(bytes, { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
  }));

  const result = await client.getConfig();

  // The forged reply is rejected by the GCM tag, so the request is served by the cloud instead.
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls, [
    'http://homeassistant.local:3589/api/secure',
    'https://relay.test/api/config',
  ]);
  assert.equal(client.getTransportMode(), 'relay');
});

test('resynchronises its sequence after the instance restarts', async () => {
  const channel = new SecureChannel(LOCAL_TOKEN, LOCAL_KEY_ID);
  const seen = [];
  const client = new FluxClient(baseConfig({
    fetchImpl: async (_input, init) => {
      const { seq } = await channel.openRequest(new Uint8Array(init.body));
      seen.push(seq);
      const replayed = seen.length === 1;
      const sealed = await channel.sealResponse(seq, {
        status: replayed ? 409 : 200,
        headers: { 'content-type': 'application/json' },
        body: new TextEncoder().encode(JSON.stringify(replayed ? { next_seq: 5000 } : { ok: true })),
      });
      return new Response(sealed, { status: 200 });
    },
  }));

  const result = await client.getConfig();

  assert.deepEqual(result, { ok: true });
  assert.equal(seen.length, 2);
  assert.equal(seen[1], 5001);
});

test('switches to a reachable local instance using the same access token', async () => {
  const calls = [];
  const serve = localInstance(() => ({ body: { ok: true } }));
  const client = new FluxClient({
    relayUrl: 'https://relay.test',
    instanceId: 'instance-a',
    accessToken: LOCAL_TOKEN,
    keyId: LOCAL_KEY_ID,
    relaySession: 'relay-session',
    autoConnect: false,
    fetchImpl: async (input, init) => {
      const url = String(input);
      if (url === 'http://homeassistant.local:3589/health') {
        calls.push('health');
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url === 'http://homeassistant.local:3589/api/secure') {
        calls.push('secure');
        return await serve(init, []);
      }
      throw new Error(`Unexpected request: ${url}`);
    },
  });

  const result = await client.getConfig();

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls, ['health', 'secure']);
  assert.equal(client.getTransportMode(), 'local');
});

test('automatically falls back to cloud when the default local instance is unavailable', async () => {
  const calls = [];
  const client = new FluxClient({
    relayUrl: 'https://relay.test',
    instanceId: 'instance-a',
    accessToken: 'instance-token',
    relaySession: 'relay-session',
    autoConnect: false,
    fetchImpl: async (input) => {
      const url = String(input);
      calls.push(url);
      if (url === 'http://homeassistant.local:3589/health') throw new Error('unreachable');
      if (url === 'https://relay.test/api/config') {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      throw new Error(`Unexpected request: ${url}`);
    },
  });

  const result = await client.getConfig();

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls, [
    'http://homeassistant.local:3589/health',
    'https://relay.test/api/config',
  ]);
  assert.equal(client.getTransportMode(), 'relay');
});

test('sends the relay session alongside the instance token on cloud requests', async () => {
  let headers;
  const client = new FluxClient(baseConfig({
    localUseLan: false,
    networkMonitor: { isOnLocalNetwork: () => false },
    fetchImpl: async (_input, init) => {
      headers = init?.headers;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
  }));

  await client.getConfig();

  assert.equal(headers['x-relay-session'], 'relay-session');
  assert.equal(headers.Authorization, 'Bearer instance-token');
  assert.equal(headers['x-instance-id'], 'instance-a');
});

test('falls back to the cloud when the local instance rejects the envelope', async () => {
  const calls = [];
  const client = new FluxClient(baseConfig({
    fetchImpl: async (input) => {
      const url = String(input);
      calls.push(url);
      if (url === 'http://homeassistant.local:3589/api/secure') {
        return new Response('unknown session', { status: 401 });
      }
      if (url === 'https://relay.test/api/config') {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      throw new Error(`Unexpected request: ${url}`);
    },
  }));

  const result = await client.getConfig();

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls, [
    'http://homeassistant.local:3589/api/secure',
    'https://relay.test/api/config',
  ]);
  assert.equal(client.getTransportMode(), 'relay');
});

test('falls back to the cloud relay when the local instance request fails', async () => {
  const calls = [];
  const client = new FluxClient(baseConfig({
    fetchImpl: async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.startsWith('http://homeassistant.local:3589')) {
        throw new Error('local instance unreachable');
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
  }));

  const result = await client.getConfig();

  assert.deepEqual(result, { ok: true });
  assert.equal(calls.length, 2);
  assert.match(calls[1], /^https:\/\/relay\.test/);
  assert.equal(client.getTransportMode(), 'relay');
});

test('skips the local instance and goes straight to the cloud when the network monitor reports it is unreachable', async () => {
  const calls = [];
  const client = new FluxClient(baseConfig({
    networkMonitor: { isOnLocalNetwork: () => false },
    fetchImpl: async (input) => {
      const url = String(input);
      calls.push(url);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
  }));

  await client.getConfig();

  assert.equal(calls.length, 1);
  assert.match(calls[0], /^https:\/\/relay\.test/);
  assert.equal(client.getTransportMode(), 'relay');
});