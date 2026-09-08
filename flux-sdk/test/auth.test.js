import test from 'node:test';
import assert from 'node:assert/strict';
import { FluxClient } from '../dist/client.js';

const createJsonResponse = (body, init = {}) => new Response(JSON.stringify(body), {
  status: 200,
  headers: { 'Content-Type': 'application/json' },
  ...init,
});

test('register stores an auth session for later requests', async () => {
  const calls = [];
  const client = new FluxClient({
    relayUrl: 'http://relay.test',
    tenantId: 'tenant-a',
    tenantToken: 'tenant-token',
    autoConnect: false,
    fetchImpl: async (input, init) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? 'GET', headers: init?.headers });
      if (url.endsWith('/api/auth/register')) {
        return createJsonResponse({ success: true, message: 'ok', data: { user: 'alice', token: 'abc123', tenantId: 'tenant-a' } });
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
    tenantId: 'tenant-a',
    tenantToken: 'tenant-token',
    autoConnect: false,
    fetchImpl: async (input) => {
      const url = String(input);
      if (url.endsWith('/api/auth/login')) {
        return createJsonResponse({ success: true, message: 'ok', data: { user: 'bob', token: 'def456', tenantId: 'tenant-a' } });
      }
      throw new Error(`Unexpected request: ${url}`);
    },
  });

  const session = await client.login({ username: 'Bob', password: 'secret' });

  assert.equal(session.user, 'bob');
  assert.equal(client.getAuthSession()?.token, 'def456');
});

test('download decodes the relay file envelope into a Blob', async () => {
  const client = new FluxClient({
    relayUrl: 'https://relay.test',
    tenantId: 'tenant-a',
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

test('connect rejects an unconfigured relay URL and tenant', async () => {
  const client = new FluxClient({
    relayUrl: '',
    tenantId: '',
    autoConnect: false,
    fetchImpl: async () => createJsonResponse({ ok: true }),
  });

  await assert.rejects(() => client.connect(), /Relay URL and tenant ID are required/i);
});
