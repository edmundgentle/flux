import test from 'node:test';
import assert from 'node:assert/strict';
import { FluxClient } from '../dist/client.js';
import { SecureChannel } from '../dist/secure.js';

const createJsonResponse = (body, init = {}) => new Response(JSON.stringify(body), {
  status: 200,
  headers: { 'Content-Type': 'application/json' },
  ...init,
});

test('register stores an auth session for later requests', async () => {
  const calls = [];
  const client = new FluxClient({
    relayUrl: 'http://relay.test',
    instanceId: 'instance-a',
    instanceToken: 'instance-token',
    autoConnect: false,
    fetchImpl: async (input, init) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? 'GET', headers: init?.headers });
      if (url.endsWith('/api/auth/register')) {
        return createJsonResponse({ success: true, message: 'ok', data: { user: 'alice', token: 'abc123', relaySession: 'relay-1', instanceId: 'instance-a' } });
      }
      throw new Error(`Unexpected request: ${url}`);
    },
  });

  const session = await client.register({ username: 'Alice', password: 'secret' });

  assert.equal(session.user, 'alice');
  assert.equal(session.token, 'abc123');
  assert.equal(client.getAuthSession()?.token, 'abc123');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].url, 'http://relay.test/api/auth/register');
});

test('login stores the returned auth token', async () => {
  const client = new FluxClient({
    relayUrl: 'http://relay.test',
    instanceId: 'instance-a',
    instanceToken: 'instance-token',
    autoConnect: false,
    fetchImpl: async (input) => {
      const url = String(input);
      if (url.endsWith('/api/auth/login')) {
        return createJsonResponse({ success: true, message: 'ok', data: { user: 'bob', token: 'def456', relaySession: 'relay-1', instanceId: 'instance-a' } });
      }
      throw new Error(`Unexpected request: ${url}`);
    },
  });

  const session = await client.login({ username: 'Bob', password: 'secret' });

  assert.equal(session.user, 'bob');
  assert.equal(client.getAuthSession()?.token, 'def456');
});

test('login propagates error messages from the server', async () => {
  const client = new FluxClient({
    relayUrl: 'http://relay.test',
    instanceId: 'instance-a',
    autoConnect: false,
    fetchImpl: async (input) => {
      const url = String(input);
      if (url.endsWith('/api/auth/login')) {
        return createJsonResponse({ success: false, message: 'Invalid email or password' }, { status: 401 });
      }
      throw new Error(`Unexpected request: ${url}`);
    },
  });

  await assert.rejects(
    () => client.login({ username: 'bob', password: 'wrongpassword' }),
    /Invalid email or password/i
  );
});

test('login with specific instance requested sends instance_id', async () => {
  const calls = [];
  const client = new FluxClient({
    relayUrl: 'http://relay.test',
    instanceId: '',
    autoConnect: false,
    fetchImpl: async (input, init) => {
      calls.push(JSON.parse(init?.body));
      return createJsonResponse({
        success: true,
        data: {
          user: 'bob@example.com',
          token: 'tok-123',
          relaySession: 'relay-1',
          instanceId: 'instance-custom',
          instances: [{ instanceId: 'instance-custom', label: 'My House' }],
        },
      });
    },
  });

  const session = await client.login({ username: 'bob@example.com', password: 'secret', instanceId: 'instance-custom' });

  assert.equal(session.instanceId, 'instance-custom');
  assert.equal(calls[0].instance_id, 'instance-custom');
  assert.equal(client.getAuthSession()?.token, 'tok-123');
});

test('mints an instance token when login could not reach the instance', async () => {
  const calls = [];
  const client = new FluxClient({
    relayUrl: 'https://relay.test',
    instanceId: '',
    autoConnect: false,
    fetchImpl: async (input, init) => {
      const url = String(input);
      calls.push({ url, headers: init?.headers });
      if (url.endsWith('/api/auth/login')) {
        return createJsonResponse({ success: true, data: { user: 'alice', relaySession: 'relay-1', instanceId: 'instance-a' } });
      }
      return createJsonResponse({ success: true, data: { user: 'alice', token: 'instance-token', expiresAt: '2027-01-01T00:00:00Z' } });
    },
  });

  const session = await client.login({ username: 'alice', password: 'secret' });

  assert.equal(calls[1].url, 'https://relay.test/api/auth/session');
  assert.equal(calls[1].headers['x-relay-session'], 'relay-1');
  assert.equal(calls[1].headers['x-instance-id'], 'instance-a');
  assert.equal(session.token, 'instance-token');
  assert.equal(client.getAuthSession()?.token, 'instance-token');
});

test('accepts the same token on the local instance without a second sign-in', async () => {
  const calls = [];
  const channel = new SecureChannel('instance-token', 'key-1');
  const client = new FluxClient({
    relayUrl: 'https://relay.test',
    instanceId: 'instance-a',
    accessToken: 'instance-token',
    keyId: 'key-1',
    relaySession: 'relay-1',
    autoConnect: false,
    fetchImpl: async (input, init) => {
      calls.push({ url: String(input), headers: init?.headers });
      const { seq, request } = await channel.openRequest(new Uint8Array(init.body));
      calls.push({ innerPath: request.path });
      const sealed = await channel.sealResponse(seq, {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: new TextEncoder().encode(JSON.stringify({ success: true, data: { user: 'alice' } })),
      });
      return new Response(sealed, { status: 200 });
    },
  });

  await client.useLocalInstance('http://homeassistant.local:3589');

  assert.equal(calls[0].url, 'http://homeassistant.local:3589/api/secure');
  assert.equal(calls[0].headers['x-flux-key-id'], 'key-1');
  assert.equal(calls[1].innerPath, '/api/auth/session');
  assert.equal(client.getTransportMode(), 'local');
});

test('download decodes the relay file envelope into a Blob', async () => {
  const client = new FluxClient({
    relayUrl: 'https://relay.test',
    instanceId: 'instance-a',
    accessToken: 'access-token',
    autoConnect: false,
    fetchImpl: async () => createJsonResponse({
      file_name: 'hello.txt',
      mime_type: 'text/plain',
      content_b64: 'aGVsbG8=',
    }),
  });

  const file = await client.downloadFile('/data/hello.txt');

  assert.equal(file.type, 'text/plain');
  assert.equal(await file.text(), 'hello');
});

test('download preserves a raw JSON file served by the local instance', async () => {
  const contact = {
    id: 'contact_123',
    firstName: 'Ada',
    lastName: 'Lovelace',
    emails: [{ label: 'Work', email: 'ada@example.com' }],
  };
  const client = new FluxClient({
    relayUrl: 'https://relay.test',
    instanceId: 'instance-a',
    accessToken: 'access-token',
    autoConnect: false,
    fetchImpl: async () => createJsonResponse(contact),
  });

  const file = await client.downloadFile('/data/Contacts/contact_123.json');

  assert.equal(file.type, 'application/json');
  assert.deepEqual(JSON.parse(await file.text()), contact);
});

test('connect rejects an unconfigured relay URL and instance', async () => {
  const client = new FluxClient({
    relayUrl: '',
    instanceId: '',
    autoConnect: false,
    fetchImpl: async () => createJsonResponse({ ok: true }),
  });

  await assert.rejects(() => client.connect(), /Relay URL and instance ID are required/i);
});
