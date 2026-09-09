import { WebSocket } from 'ws';
import { RelayEnvelope, ProxyRequest, ProxyResponse, InstanceId, InstanceTunnel } from './types';

export class TunnelRegistry {
  private instances = new Map<InstanceId, InstanceTunnel>();

  register(instanceId: InstanceId, socket: WebSocket, tunnelToken: string): InstanceTunnel {
    const existing = this.instances.get(instanceId);
    if (existing && existing.socket !== socket) {
      // Replace stale tunnels instead of rejecting reconnects: the HA bridge reconnects
      // aggressively on any network blip, and the old socket may not have been closed yet.
      existing.socket.removeAllListeners();
      existing.socket.terminate();
    }

    const tunnel = {
      instanceId,
      socket,
      tunnelToken,
      connectedAt: Date.now(),
      lastSeen: Date.now(),
    };
    this.instances.set(instanceId, tunnel);
    return tunnel;
  }

  unregister(instanceId: InstanceId): void {
    this.instances.delete(instanceId);
  }

  touch(instanceId: InstanceId, socket: WebSocket): void {
    const tunnel = this.instances.get(instanceId);
    if (tunnel?.socket === socket) tunnel.lastSeen = Date.now();
  }

  get(instanceId: InstanceId): InstanceTunnel | undefined {
    const tunnel = this.instances.get(instanceId);
    if (tunnel) {
      tunnel.lastSeen = Date.now();
    }
    return tunnel;
  }

  list(): InstanceTunnel[] {
    return Array.from(this.instances.values());
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

export function makeProxyResponse(payload: ProxyResponse, requestId: string, instanceId: InstanceId): RelayEnvelope<ProxyResponse> {
  return {
    type: 'proxy_response',
    instanceId,
    requestId,
    payload,
    ts: Date.now(),
  };
}
