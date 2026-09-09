import test from 'node:test';
import assert from 'node:assert/strict';
import { TunnelRegistry, parseProxyRequest, makeProxyResponse } from './relay';
import { hashPassword, verifyPassword, generateToken, hashToken, verifyTokenHash } from './security';

test('instance registry stores active tunnels by instance id', () => {
  const registry = new TunnelRegistry();
  const socket = {} as any;

  registry.register('instance-a', socket, 'tunnel-token');
  const tunnel = registry.get('instance-a');

  assert.ok(tunnel);
  assert.equal(tunnel?.instanceId, 'instance-a');
  assert.equal(registry.list().length, 1);
});

test('instance registry replaces a stale tunnel on reconnect instead of rejecting it', () => {
  const registry = new TunnelRegistry();
  const first = { removeAllListeners: () => {}, terminate: () => {} } as any;
  const second = {} as any;

  registry.register('instance-a', first, 'tunnel-token');
  registry.register('instance-a', second, 'tunnel-token');

  assert.equal(registry.get('instance-a')?.socket, second);
  assert.equal(registry.list().length, 1);
});

test('password hashing verifies correct passwords and rejects wrong ones', () => {
  const stored = hashPassword('correct-horse-battery-staple');
  assert.equal(verifyPassword('correct-horse-battery-staple', stored), true);
  assert.equal(verifyPassword('wrong-password', stored), false);
});

test('instance tokens are verified against their stored hash', () => {
  const token = generateToken();
  const stored = hashToken(token);
  assert.equal(verifyTokenHash(token, stored), true);
  assert.equal(verifyTokenHash(generateToken(), stored), false);
});

test('canonical proxy request payloads round-trip through relay envelopes', () => {
  const payload = {
    method: 'GET',
    path: '/api/search',
    query: { q: 'dog', limit: '5' },
    user: 'alice',
  };

  const parsed = parseProxyRequest(payload);
  assert.deepEqual(parsed, payload);

  const envelope = makeProxyResponse({ status: 200, body: { ok: true } }, 'req-123', 'instance-a');
  assert.equal(envelope.type, 'proxy_response');
  assert.equal(envelope.requestId, 'req-123');
  assert.equal(envelope.instanceId, 'instance-a');
  assert.equal((envelope.payload as any).status, 200);
});

