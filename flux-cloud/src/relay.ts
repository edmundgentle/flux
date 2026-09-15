import { WebSocket } from 'ws';
import { createClient } from 'redis';
import { RelayEnvelope, ProxyRequest, ProxyResponse, InstanceId, InstanceTunnel } from './types';

const commandChannel = 'flux:relay:commands';
const responseChannel = 'flux:relay:responses';

function messageText(message: unknown): string {
  if (typeof message === 'string') return message;
  if (Buffer.isBuffer(message)) return message.toString('utf8');
  return '';
}

type SharedCommand =
  | { kind: 'claim'; instanceId: InstanceId; owner: string }
  | { kind: 'proxy'; source: string; instanceId: InstanceId; requestId: string; payload: ProxyRequest; user: string };

type SharedResponse = {
  source: string;
  requestId: string;
  payload?: ProxyResponse;
  error?: string;
};

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

export class SharedRelay {
  private readonly processId = `${process.pid}-${Math.random().toString(16).slice(2)}`;
  private readonly publisher;
  private readonly subscriber;
  private readonly pending = new Map<string, { resolve: (payload: ProxyResponse) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();

  constructor(
    private readonly redisUrl: string,
    private readonly registry: TunnelRegistry,
    private readonly signUser: (tunnelToken: string, instanceId: string, requestId: string, user: string) => string,
  ) {
    const clientOptions = {
      url: redisUrl,
      pingInterval: 30_000,
      socket: {
        reconnectStrategy: (retries: number) => Math.min(1_000 * Math.max(retries, 1), 30_000),
      },
    };
    this.publisher = createClient(clientOptions);
    this.subscriber = this.publisher.duplicate();
    this.publisher.on('error', (error) => {
      console.error('Valkey publisher connection error:', error);
    });
    this.subscriber.on('error', (error) => {
      console.error('Valkey subscriber connection error:', error);
    });
  }

  async start(): Promise<void> {
    await this.publisher.connect();
    await this.subscriber.connect();
    await this.subscriber.subscribe(commandChannel, (message) => { void this.handleCommand(message); });
    await this.subscriber.subscribe(responseChannel, (message) => this.handleResponse(message));
  }

  async close(): Promise<void> {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Relay is shutting down'));
    }
    this.pending.clear();
    if (this.subscriber.isOpen) await this.subscriber.quit();
    if (this.publisher.isOpen) await this.publisher.quit();
  }

  async createWsTicket(ticket: string, instanceId: string, user: string): Promise<void> {
    await this.publisher.set(this.ticketKey(ticket), JSON.stringify({ instanceId, user }), { EX: 60 });
  }

  async consumeWsTicket(instanceId: string, ticket: string): Promise<string | undefined> {
    const value = await this.publisher.getDel(this.ticketKey(ticket));
    if (!value) return undefined;
    try {
      const entry = JSON.parse(value) as { instanceId?: string; user?: string };
      return entry.instanceId === instanceId && typeof entry.user === 'string' ? entry.user : undefined;
    } catch {
      return undefined;
    }
  }

  async claimTunnel(instanceId: string): Promise<void> {
    await this.publisher.set(this.tunnelKey(instanceId), this.processId, { EX: 120 });
    await this.publisher.publish(commandChannel, JSON.stringify({ kind: 'claim', instanceId, owner: this.processId } satisfies SharedCommand));
  }

  async renewTunnels(): Promise<void> {
    for (const tunnel of this.registry.list()) {
      const key = this.tunnelKey(tunnel.instanceId);
      if (await this.publisher.get(key) === this.processId) {
        await this.publisher.expire(key, 120);
      }
    }
  }

  async releaseTunnel(instanceId: string): Promise<void> {
    const key = this.tunnelKey(instanceId);
    if (await this.publisher.get(key) === this.processId) await this.publisher.del(key);
  }

  async request(instanceId: string, requestId: string, payload: ProxyRequest, user: string): Promise<ProxyResponse> {
    if (await this.ownsTunnel(instanceId)) {
      const response = await this.dispatchToTunnel(instanceId, requestId, payload, user);
      if (response) return response;
    }

    return new Promise<ProxyResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error('Proxy request timeout'));
      }, 30000);
      this.pending.set(requestId, { resolve, reject, timer });
      void this.publisher.publish(commandChannel, JSON.stringify({
        kind: 'proxy', source: this.processId, instanceId, requestId, payload, user,
      } satisfies SharedCommand));
    });
  }

  private async handleCommand(message: string): Promise<void> {
    let command: SharedCommand;
    try {
      command = JSON.parse(message) as SharedCommand;
    } catch {
      return;
    }

    if (command.kind === 'claim') {
      if (command.owner !== this.processId) {
        const tunnel = this.registry.get(command.instanceId);
        if (tunnel) {
          this.registry.unregister(command.instanceId);
          tunnel.socket.terminate();
        }
      }
      return;
    }

    if (command.kind !== 'proxy' || command.source === this.processId || !(await this.ownsTunnel(command.instanceId))) return;
    const response = await this.dispatchToTunnel(command.instanceId, command.requestId, command.payload, command.user);
    await this.publisher.publish(responseChannel, JSON.stringify({
      source: command.source,
      requestId: command.requestId,
      ...(response ? { payload: response } : { error: 'No active tunnel for instance' }),
    } satisfies SharedResponse));
  }

  private handleResponse(message: string): void {
    let response: SharedResponse;
    try {
      response = JSON.parse(message) as SharedResponse;
    } catch {
      return;
    }
    if (response.source !== this.processId) return;
    const pending = this.pending.get(response.requestId);
    if (!pending) return;
    this.pending.delete(response.requestId);
    clearTimeout(pending.timer);
    if (response.error) pending.reject(new Error(response.error));
    else pending.resolve(response.payload || { status: 502, body: {} });
  }

  private async dispatchToTunnel(instanceId: string, requestId: string, payload: ProxyRequest, user: string): Promise<ProxyResponse | undefined> {
    const tunnel = this.registry.get(instanceId);
    if (!tunnel || !(await this.ownsTunnel(instanceId))) return undefined;
    const relayRequest: RelayEnvelope<ProxyRequest> = {
      type: 'proxy_request',
      instanceId,
      requestId,
      payload: {
        ...payload,
        user,
        userSignature: this.signUser(tunnel.tunnelToken, instanceId, requestId, user),
      },
      ts: Date.now(),
    };

    return new Promise<ProxyResponse>((resolve, reject) => {
      const listener = (message: unknown) => {
        try {
          const obj = JSON.parse(messageText(message));
          if (!isJsonEnvelope(obj) || obj.requestId !== requestId) return;
          tunnel.socket.off('message', listener);
          if (obj.type === 'proxy_response') resolve((obj.payload as ProxyResponse) || { status: 200, body: {} });
          else if (obj.type === 'error') reject(new Error(obj.error || 'Proxy failed'));
        } catch {
          // Ignore unrelated or malformed tunnel messages.
        }
      };
      tunnel.socket.on('message', listener);
      sendEnvelope(tunnel.socket, relayRequest);
      setTimeout(() => {
        tunnel.socket.off('message', listener);
        reject(new Error('Proxy request timeout'));
      }, 30000);
    });
  }

  private async ownsTunnel(instanceId: string): Promise<boolean> {
    return (await this.publisher.get(this.tunnelKey(instanceId))) === this.processId;
  }

  private ticketKey(ticket: string): string { return `flux:relay:ticket:${ticket}`; }
  private tunnelKey(instanceId: string): string { return `flux:relay:tunnel:${instanceId}`; }
}
