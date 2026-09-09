import { FeatureConfig, SearchRequest, SearchResult, ConnectionState, RequestEnvelope, ResponseEnvelope, ProxyRequest, ProxyResponse, FileUploadOptions, DownloadOptions, WebSocketLike, AuthCredentials, AuthSession, TransportMode, DiagnosticEvent } from './types.js';
import { buildRelaySocketUrl, getMimeType, sleep, uuid, safeJsonParse } from './utils.js';

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export class FluxClient {
  private config: FeatureConfig;
  private socket: WebSocketLike | null = null;
  private pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private reconnectDelay = 1000;
  private state: ConnectionState = 'disconnected';
  private listeners: Array<(state: ConnectionState) => void> = [];
  private fetchImpl: typeof fetch;
  private authSession: AuthSession | null = null;
  private reconnectEnabled = true;

  private diagnostic(level: DiagnosticEvent['level'], event: string, message: string): void {
    this.config.onDiagnostic?.({ timestamp: Date.now(), level, transport: this.getTransportMode(), event, message });
  }

  constructor(config: FeatureConfig) {
    this.config = config;
    this.fetchImpl = config.fetchImpl ?? fetch.bind(globalThis);
    if (config.autoConnect !== false) void this.connect();
  }

  public onStateChange(listener: (state: ConnectionState) => void): () => void {
    this.listeners.push(listener);
    return () => { this.listeners = this.listeners.filter((item) => item !== listener); };
  }

  public getState(): ConnectionState { return this.state; }
  public getAuthSession(): AuthSession | null { return this.authSession; }
  public getTransportMode(): TransportMode { return this.usesLanTransport() ? 'local' : 'relay'; }

  private usesLanTransport(): boolean {
    return Boolean(this.config.localBaseUrl && this.config.localUseLan);
  }

  public async register(credentials: AuthCredentials): Promise<AuthSession> {
    return await this.authenticate('/api/auth/register', { email: credentials.username.trim(), password: credentials.password, label: credentials.displayName?.trim() || undefined }, 'register');
  }

  public async login(credentials: AuthCredentials): Promise<AuthSession> {
    return await this.authenticate('/api/auth/login', { email: credentials.username.trim(), password: credentials.password, tenant_id: credentials.tenantId }, 'login');
  }

  public logout(): void {
    this.reconnectEnabled = false;
    this.authSession = null;
    this.config.accessToken = undefined;
    for (const pending of this.pending.values()) pending.reject(new Error('Signed out'));
    this.pending.clear();
    if (this.socket) {
      this.socket.close(1000, 'Signed out');
      this.socket = null;
    }
    this.setState('disconnected');
  }

  private async authenticate(path: string, body: Record<string, string | undefined>, action: string): Promise<AuthSession> {
    const response = await this.fetchImpl(new URL(path, this.config.relayUrl), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const payload = await response.json() as { message?: string; data?: AuthSession };
    const session = payload.data;
    if (!response.ok || !session?.token || !session.tenantId) throw new Error(payload.message || `${action} failed`);
    this.config.tenantId = session.tenantId;
    this.config.accessToken = session.token;
    this.authSession = session;
    return session;
  }

  public async connect(): Promise<void> {
    this.reconnectEnabled = true;
    if (this.usesLanTransport()) {
      this.diagnostic('info', 'transport.local', 'Using local network HTTP; relay socket skipped');
      this.setState('connected');
      return;
    }
    if (this.socket?.readyState === 1) return;
    const relayUrl = this.config.relayUrl?.trim();
    const tenantId = this.config.tenantId?.trim();
    if (!relayUrl || !tenantId) {
      throw new Error('Relay URL and tenant ID are required before connecting');
    }
    const accessToken = this.authSession?.token || this.config.accessToken;
    if (!accessToken) throw new Error('Sign in before connecting to the relay');
    this.setState('connecting');
    let ticketResponse: Response;
    try {
      ticketResponse = await this.fetchImpl(new URL('/api/auth/ws-ticket', relayUrl), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
          'x-tenant-id': this.config.tenantId,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Cloud relay ticket request failed';
      this.diagnostic('error', 'relay.ticket.error', `Could not reach cloud relay: ${message}`);
      throw error;
    }
    const ticketPayload = await ticketResponse.json() as { data?: { ticket?: string }; message?: string };
    const ticket = ticketPayload.data?.ticket;
    if (!ticketResponse.ok || !ticket) {
      const message = ticketPayload.message || `Relay ticket request failed (${ticketResponse.status})`;
      this.diagnostic('error', 'relay.ticket.failed', message);
      throw new Error(message);
    }
    this.diagnostic('info', 'relay.ticket.success', 'Cloud relay ticket received; opening WebSocket');
    const SocketCtor = this.config.websocketCtor ?? WebSocket;
    const socket = new SocketCtor(buildRelaySocketUrl(this.config.relayUrl, this.config.tenantId, ticket)) as WebSocketLike;
    this.socket = socket;
    let socketOpened = false;
    const socketReady = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.diagnostic('error', 'relay.socket.timeout', 'Cloud relay WebSocket did not open within 10 seconds');
        reject(new Error('Cloud relay WebSocket connection timed out'));
      }, 10000);
      socket.onopen = () => {
        clearTimeout(timeout);
        socketOpened = true;
        this.reconnectDelay = 1000;
        this.setState('connected');
        this.diagnostic('info', 'relay.socket.open', 'Cloud relay WebSocket connected; Home Assistant tunnel is reachable through relay');
        resolve();
      };
      socket.onerror = () => {
        clearTimeout(timeout);
        this.setState('reconnecting');
        this.diagnostic('error', 'relay.socket.error', 'Cloud relay WebSocket reported an error');
        if (!socketOpened) reject(new Error('Relay socket failed to connect'));
      };
      socket.onclose = (event) => {
        clearTimeout(timeout);
        this.socket = null;
        const details = `code=${event.code ?? 'unknown'} reason=${event.reason || 'none'} clean=${event.wasClean ?? 'unknown'}`;
        const message = socketOpened
          ? `Cloud relay WebSocket closed (${details})`
          : `Cloud relay WebSocket closed before opening (${details})`;
        this.diagnostic('warn', 'relay.socket.close', message);
        if (!socketOpened) reject(new Error(message));
        if (this.reconnectEnabled) {
          this.setState('reconnecting');
          void this.retryConnect();
        } else {
          this.setState('disconnected');
        }
      };
    });
    socket.onmessage = (event) => {
      const parsed = safeJsonParse<ResponseEnvelope<unknown>>(typeof event.data === 'string' ? event.data : '');
      if (!parsed?.requestId) return;
      const pending = this.pending.get(parsed.requestId);
      if (!pending) return;
      this.pending.delete(parsed.requestId);
      if (parsed.type === 'error') pending.reject(new Error(parsed.error ?? 'Relay request failed'));
      else pending.resolve(parsed.payload ?? {});
    };
    await socketReady;
  }

  private async retryConnect(): Promise<void> {
    if (!this.reconnectEnabled || this.state === 'connecting') return;
    await sleep(this.reconnectDelay);
    if (!this.reconnectEnabled) return;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
    this.diagnostic('info', 'relay.reconnect.start', `Retrying cloud relay connection (next delay ${this.reconnectDelay}ms)`);
    try {
      await this.connect();
    } catch {
      this.diagnostic('warn', 'relay.reconnect.failed', 'Cloud relay reconnect attempt failed; will retry');
      if (this.reconnectEnabled) void this.retryConnect();
    }
  }

  private setState(next: ConnectionState): void {
    if (this.state === next) return;
    this.state = next;
    for (const listener of this.listeners) listener(next);
  }

  private async sendRelayRequest<T>(payload: ProxyRequest): Promise<T> {
    await this.connect();
    if (!this.socket || this.socket.readyState !== 1) throw new Error('Relay socket is not connected');
    this.diagnostic('info', 'relay.request.start', `${payload.method} ${payload.path} sent through cloud relay`);
    const requestId = uuid();
    const request: RequestEnvelope<ProxyRequest> = { type: 'proxy_request', tenantId: this.config.tenantId, requestId, payload, ts: Date.now() };
    return await new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        this.diagnostic('error', 'relay.request.timeout', `${payload.method} ${payload.path} timed out; check whether the Home Assistant tunnel is connected to the relay`);
        reject(new Error(`${this.getTransportMode() === 'local' ? 'Local network' : 'Cloud relay'} request timed out`));
      }, 30000);
      this.pending.set(requestId, { resolve: (value) => { clearTimeout(timeout); resolve(value as T); }, reject: (error) => { clearTimeout(timeout); reject(error); } });
      this.socket!.send(JSON.stringify(request));
    });
  }

  private async httpRequest<T>(path: string, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', body?: unknown): Promise<T> {
    const useLan = this.usesLanTransport();
    const base = useLan ? this.config.localBaseUrl! : this.config.relayUrl;
    const token = useLan ? this.config.localAccessToken : (this.authSession?.token || this.config.accessToken);
    const response = await this.fetchImpl(new URL(path, base), { method, headers: { 'Content-Type': 'application/json', ...(useLan ? {} : { 'x-tenant-id': this.config.tenantId }), Authorization: `Bearer ${token || ''}` }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    if (!response.ok) throw new Error(text || `Request failed: ${response.status}`);
    return text ? JSON.parse(text) as T : undefined as T;
  }

  public async search(params: SearchRequest): Promise<SearchResult[]> {
    if (this.config.localUseLan && this.config.localBaseUrl) {
      const url = new URL('/api/search', this.config.localBaseUrl);
      url.searchParams.set('q', params.q);
      url.searchParams.set('limit', String(params.limit ?? 20));
      const response = await this.fetchImpl(url, {
        headers: { Authorization: `Bearer ${this.config.localAccessToken || ''}` },
      });
      if (!response.ok) throw new Error(`Search failed: ${response.status}`);
      return await response.json() as SearchResult[];
    }
    const payload = await this.sendRelayRequest<ProxyResponse<SearchResult[]>>({ method: 'GET', path: '/api/search', query: { q: params.q, limit: String(params.limit ?? 20) }, headers: { Authorization: `Bearer ${this.authSession?.token || this.config.accessToken || ''}` } });
    if (!payload || payload.status >= 400) throw new Error('Search failed');
    return (payload.body ?? payload.data ?? []) as SearchResult[];
  }

  public async uploadFile(file: Blob | ArrayBuffer | Uint8Array, options: FileUploadOptions = {}): Promise<{ path: string }> {
    const fileName = options.path || `upload-${Date.now()}.bin`;
    const uploadPath = options.directory
      ? `${options.directory.replace(/\/+$/, '')}/${fileName.replace(/^\/+/, '')}`
      : fileName;
    const arrayBuffer = await (file instanceof Blob
      ? file.arrayBuffer()
      : Promise.resolve(file instanceof Uint8Array
        ? file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength)
        : file));
    const bytes = new Uint8Array(arrayBuffer as ArrayBufferLike);
    if (this.config.localUseLan && this.config.localBaseUrl) {
      const url = new URL('/api/files/upload', this.config.localBaseUrl);
      url.searchParams.set('path', uploadPath);
      const form = new FormData();
      form.append('file', new Blob([bytes.buffer as ArrayBuffer], { type: getMimeType(fileName) }), fileName);
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.config.localAccessToken || ''}` },
        body: form,
      });
      const payload = await response.json() as { data?: string; message?: string };
      if (!response.ok) throw new Error(payload.message || `Upload failed: ${response.status}`);
      return { path: payload.data || uploadPath };
    }
    const payload = await this.sendRelayRequest<ProxyResponse<{ path: string }>>({ method: 'POST', path: '/api/files/upload', query: { path: uploadPath }, headers: { Authorization: `Bearer ${this.authSession?.token || this.config.accessToken || ''}` }, body: { file_name: fileName, content_b64: encodeBase64(bytes) } });
    if (!payload || payload.status >= 400) throw new Error('Upload failed');
    return (payload.body ?? payload.data ?? { path: uploadPath }) as { path: string };
  }

  public async downloadFile(path: string, options: DownloadOptions = {}): Promise<Blob> {
    const useLan = this.usesLanTransport();
    const base = useLan ? this.config.localBaseUrl! : this.config.relayUrl;
    const token = useLan ? this.config.localAccessToken : (this.authSession?.token || this.config.accessToken);
    const url = new URL('/api/files/download', base);
    if (!useLan) url.searchParams.set('tenant_id', this.config.tenantId);
    url.searchParams.set('path', path);
    if (options.user) url.searchParams.set('user', options.user);
    const response = await this.fetchImpl(url, { headers: { Authorization: `Bearer ${token || ''}` } });
    if (!response.ok) throw new Error(`Download failed: ${response.status}`);
    if (!response.headers.get('content-type')?.includes('application/json')) return await response.blob();
    const payload = await response.json() as { content_b64?: string; mime_type?: string; file_name?: string };
    if (!payload.content_b64) throw new Error('Download response did not include file content');
    const bytes = decodeBase64(payload.content_b64);
    return new Blob([bytes.buffer as ArrayBuffer], { type: payload.mime_type || 'application/octet-stream' });
  }

  public async getConfig(): Promise<Record<string, unknown>> { return await this.httpRequest('/api/config', 'GET'); }

  public async disconnect(): Promise<void> {
    this.reconnectEnabled = false;
    if (this.socket) { this.socket.close(); this.socket = null; }
    this.setState('disconnected');
  }
}

export type FluxClientConstructor = typeof FluxClient;
