import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRelaySocketUrl } from '../dist/utils.js';
import { FluxClient } from '../dist/client.js';

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
    accessToken: 'cloud-token',
    localBaseUrl: 'http://homeassistant.local:8080',
    localAccessToken: 'local-token',
    localUseLan: true,
    autoConnect: false,
    ...overrides,
  };
}

test('favours the local instance when it is reachable', async () => {
  const calls = [];
  const client = new FluxClient(baseConfig({
    fetchImpl: async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.startsWith('http://homeassistant.local:8080')) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      throw new Error(`Unexpected request: ${url}`);
    },
  }));

  const result = await client.getConfig();

  assert.deepEqual(result, { ok: true });
  assert.equal(calls.length, 1);
  assert.match(calls[0], /^http:\/\/homeassistant\.local:8080/);
  assert.equal(client.getTransportMode(), 'local');
});

test('automatically exchanges a cloud session for a reachable local instance', async () => {
  const calls = [];
  const client = new FluxClient({
    relayUrl: 'https://relay.test',
    instanceId: 'instance-a',
    accessToken: 'cloud-token',
    autoConnect: false,
    fetchImpl: async (input) => {
      const url = String(input);
      calls.push(url);
      if (url === 'http://homeassistant.local:8080/health') {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url === 'https://relay.test/api/auth/local-session') {
        return new Response(JSON.stringify({ success: true, data: { token: 'local-token' } }), { status: 200 });
      }
      if (url === 'http://homeassistant.local:8080/api/config') {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      throw new Error(`Unexpected request: ${url}`);
    },
  });

  const result = await client.getConfig();

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls, [
    'http://homeassistant.local:8080/health',
    'https://relay.test/api/auth/local-session',
    'http://homeassistant.local:8080/api/config',
  ]);
  assert.equal(client.getTransportMode(), 'local');
});

test('automatically falls back to cloud when the default local instance is unavailable', async () => {
  const calls = [];
  const client = new FluxClient({
    relayUrl: 'https://relay.test',
    instanceId: 'instance-a',
    accessToken: 'cloud-token',
    autoConnect: false,
    fetchImpl: async (input) => {
      const url = String(input);
      calls.push(url);
      if (url === 'http://homeassistant.local:8080/health') throw new Error('unreachable');
      if (url === 'https://relay.test/api/config') {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      throw new Error(`Unexpected request: ${url}`);
    },
  });

  const result = await client.getConfig();

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls, [
    'http://homeassistant.local:8080/health',
    'https://relay.test/api/config',
  ]);
  assert.equal(client.getTransportMode(), 'relay');
});

test('renews an expired local token before falling back to cloud', async () => {
  const calls = [];
  const client = new FluxClient(baseConfig({
    fetchImpl: async (input, init) => {
      const url = String(input);
      calls.push({ url, authorization: init?.headers?.Authorization });
      if (url === 'http://homeassistant.local:8080/api/config' && init?.headers?.Authorization === 'Bearer local-token') {
        return new Response('expired', { status: 401 });
      }
      if (url === 'http://homeassistant.local:8080/health') {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url === 'https://relay.test/api/auth/local-session') {
        return new Response(JSON.stringify({ success: true, data: { token: 'renewed-local-token' } }), { status: 200 });
      }
      if (url === 'http://homeassistant.local:8080/api/config' && init?.headers?.Authorization === 'Bearer renewed-local-token') {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      throw new Error(`Unexpected request: ${url}`);
    },
  }));

  const result = await client.getConfig();

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls.map((call) => call.url), [
    'http://homeassistant.local:8080/api/config',
    'http://homeassistant.local:8080/health',
    'https://relay.test/api/auth/local-session',
    'http://homeassistant.local:8080/api/config',
  ]);
  assert.equal(client.getTransportMode(), 'local');
});

test('falls back to the cloud relay when the local instance request fails', async () => {
  const calls = [];
  const client = new FluxClient(baseConfig({
    fetchImpl: async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.startsWith('http://homeassistant.local:8080')) {
        throw new Error('local instance unreachable');
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
  }));

  const result = await client.getConfig();

  assert.deepEqual(result, { ok: true });
  assert.equal(calls.length, 3);
  assert.match(calls[1], /^http:\/\/homeassistant\.local:8080\/health/);
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