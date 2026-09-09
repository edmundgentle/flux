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
  assert.equal(calls.length, 2);
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