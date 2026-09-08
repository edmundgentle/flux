import { WebSocket } from 'ws';
import { RelayEnvelope, ProxyRequest, ProxyResponse, TenantId, TenantTunnel } from './types';

export class TunnelRegistry {
  private tenants = new Map<TenantId, TenantTunnel>();

  register(tenantId: TenantId, socket: WebSocket, tunnelToken: string): TenantTunnel {
    const existing = this.tenants.get(tenantId);
    if (existing) {
      throw new Error(`Tenant ${tenantId} is already connected`);
    }

    const tunnel = {
      tenantId,
      socket,
      tunnelToken,
      connectedAt: Date.now(),
      lastSeen: Date.now(),
    };
    this.tenants.set(tenantId, tunnel);
    return tunnel;
  }

  unregister(tenantId: TenantId): void {
    this.tenants.delete(tenantId);
  }

  touch(tenantId: TenantId, socket: WebSocket): void {
    const tunnel = this.tenants.get(tenantId);
    if (tunnel?.socket === socket) tunnel.lastSeen = Date.now();
  }

  get(tenantId: TenantId): TenantTunnel | undefined {
    const tunnel = this.tenants.get(tenantId);
    if (tunnel) {
      tunnel.lastSeen = Date.now();
    }
    return tunnel;
  }

  list(): TenantTunnel[] {
    return Array.from(this.tenants.values());
  }
}

export function sendEnvelope(socket: WebSocket, envelope: RelayEnvelope): void {
  socket.send(JSON.stringify(envelope));
}

export function isJsonEnvelope(value: unknown): value is RelayEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const data = value as Record<string, unknown>;
  return typeof data.type === 'string' || typeof data.type_name === 'string';
}

export function parseProxyRequest(value: unknown): ProxyRequest | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const data = value as Partial<ProxyRequest>;
  if (!data.method || !data.path) return undefined;
  return data as ProxyRequest;
}

export function makeProxyResponse(payload: ProxyResponse, requestId: string, tenantId: TenantId): RelayEnvelope<ProxyResponse> {
  return {
    type: 'proxy_response',
    tenantId,
    requestId,
    payload,
    ts: Date.now(),
  };
}
