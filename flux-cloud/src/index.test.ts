import test from 'node:test';
import assert from 'node:assert/strict';
import { TunnelRegistry, parseProxyRequest, makeProxyResponse } from './relay';
import { hashPassword, verifyPassword, generateToken, hashToken, verifyTokenHash } from './security';

test('tenant registry stores active tunnels by tenant id', () => {
  const registry = new TunnelRegistry();
  const socket = {} as any;

  registry.register('tenant-a', socket, 'tunnel-token');
  const tunnel = registry.get('tenant-a');

  assert.ok(tunnel);
  assert.equal(tunnel?.tenantId, 'tenant-a');
  assert.equal(registry.list().length, 1);
});

test('tenant registry rejects silent takeover of an active tenant tunnel', () => {
  const registry = new TunnelRegistry();
  const first = {} as any;
  const second = {} as any;

  registry.register('tenant-a', first, 'tunnel-token');

  assert.throws(() => registry.register('tenant-a', second, 'tunnel-token'), /already connected/i);
  assert.equal(registry.get('tenant-a')?.socket, first);
});

test('password hashing verifies correct passwords and rejects wrong ones', () => {
  const stored = hashPassword('correct-horse-battery-staple');
  assert.equal(verifyPassword('correct-horse-battery-staple', stored), true);
  assert.equal(verifyPassword('wrong-password', stored), false);
});

test('tenant tokens are verified against their stored hash', () => {
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

  const envelope = makeProxyResponse({ status: 200, body: { ok: true } }, 'req-123', 'tenant-a');
  assert.equal(envelope.type, 'proxy_response');
  assert.equal(envelope.requestId, 'req-123');
  assert.equal(envelope.tenantId, 'tenant-a');
  assert.equal((envelope.payload as any).status, 200);
});

