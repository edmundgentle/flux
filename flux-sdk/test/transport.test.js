import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRelaySocketUrl } from '../dist/utils.js';

test('buildRelaySocketUrl converts relay HTTP URLs to the websocket endpoint', () => {
  assert.equal(
    buildRelaySocketUrl('https://relay.example.com', 'tenant-a', 'ticket'),
    'wss://relay.example.com/ws?tenant_id=tenant-a&ws_ticket=ticket',
  );
});

test('buildRelaySocketUrl preserves an existing websocket path', () => {
  assert.equal(
    buildRelaySocketUrl('wss://relay.example.com/ws', 'tenant-a', 'ticket'),
    'wss://relay.example.com/ws?tenant_id=tenant-a&ws_ticket=ticket',
  );
});