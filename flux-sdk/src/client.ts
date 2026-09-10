import { FeatureConfig, SearchRequest, SearchResult, ConnectionState, RequestEnvelope, ResponseEnvelope, ProxyRequest, ProxyResponse, FileUploadOptions, DownloadOptions, WebSocketLike, AuthCredentials, AuthSession, TransportMode, DiagnosticEvent, AuthStorage, NetworkMonitor } from './types.js';
import { buildRelaySocketUrl, getMimeType, sleep, uuid, safeJsonParse } from './utils.js';

/** The Flux cloud relay URL. Fixed and not user-customisable; only overridable for tests. */
export const FLUX_CLOUD_URL = 'https://flux-relay-fvnyy.ondigitalocean.app';

const DEFAULT_STORAGE_KEY = 'flux.auth.session';
const DEFAULT_LOCAL_BASE_URL = 'http://homeassistant.local:8080';

type PersistedAuthState = {
  session?: AuthSession;
  local?: { baseUrl: string; accessToken: string };
};

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

/**
 * Builds a Blob from raw bytes. React Native's Blob implementation doesn't support
 * constructing a Blob directly from an ArrayBuffer/ArrayBufferView ("Creating blobs from
 * 'ArrayBuffer' and 'ArrayBufferView' are not supported"), so fall back to fetching a
 * data URI there, which its fetch/Blob implementation does support.
 */
async function bytesToBlob(bytes: Uint8Array, mimeType: string): Promise<Blob> {
  try {
    return new Blob([bytes.buffer as ArrayBuffer], { type: mimeType });
  } catch {
    const dataUri = `data:${mimeType};base64,${encodeBase64(bytes)}`;
    const response = await fetch(dataUri);
    return await response.blob();
  }
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
  private storage: AuthStorage | null;
  private storageKey: string;
  private networkMonitor: NetworkMonitor | null;
  private isOnLocalNetwork: boolean | null = null;
  private localSessionExchange: Promise<void> | null = null;
  /** Which transport actually served the most recent (or currently in-flight) request. */
  private activeTransport: TransportMode = 'relay';

  /** Resolves once any previously persisted session has been restored from storage. */
  public readonly ready: Promise<void>;

  private diagnostic(level: DiagnosticEvent['level'], event: string, message: string): void {
    this.config.onDiagnostic?.({ timestamp: Date.now(), level, transport: this.getTransportMode(), event, message });
  }

  constructor(config: FeatureConfig) {
    this.config = { ...config, relayUrl: config.relayUrl || FLUX_CLOUD_URL };
    this.fetchImpl = config.fetchImpl ?? fetch.bind(globalThis);
    this.storage = config.storage ?? null;
    this.storageKey = config.storageKey ?? DEFAULT_STORAGE_KEY;
    this.networkMonitor = config.networkMonitor ?? null;
    this.isOnLocalNetwork = this.networkMonitor?.isOnLocalNetwork() ?? null;
    this.networkMonitor?.subscribe?.((status) => {
      this.isOnLocalNetwork = status;
      const label = status === false ? 'unreachable' : status === true ? 'reachable' : 'unknown';
      this.diagnostic('info', 'network.status', `Local network reachability changed: ${label}`);
    });
    this.ready = this.restoreSession().then(() => {
      this.activeTransport = this.preferredTransport();
      if (config.autoConnect !== false) void this.connect().catch(() => {});
    });
  }

  private async restoreSession(): Promise<void> {
    if (!this.storage) return;
    try {
      const raw = await this.storage.getItem(this.storageKey);
      if (!raw) return;
      const state = safeJsonParse<PersistedAuthState>(raw);
      if (state?.session) {
        this.authSession = state.session;
        this.config.accessToken = state.session.token;
        this.config.instanceId = state.session.instanceId;
      }
      if (state?.local) {
        this.config.localBaseUrl = state.local.baseUrl;
        this.config.localAccessToken = state.local.accessToken;
        this.config.localUseLan = true;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to restore session';
      this.diagnostic('warn', 'auth.restore.failed', message);
    }
  }

  private async persistState(): Promise<void> {
    if (!this.storage) return;
    const state: PersistedAuthState = {
      session: this.authSession ?? undefined,
      local: this.config.localUseLan && this.config.localBaseUrl && this.config.localAccessToken
        ? { baseUrl: this.config.localBaseUrl, accessToken: this.config.localAccessToken }
        : undefined,
    };
    if (!state.session && !state.local) {
      await this.storage.removeItem(this.storageKey);
      return;
    }
    await this.storage.setItem(this.storageKey, JSON.stringify(state));
  }

  /** True once a cloud or local session has been established (via login, register, loginLocal, or restored from storage). */
  public isLoggedIn(): boolean {
    return Boolean(this.authSession?.token || (this.config.localUseLan && this.config.localAccessToken));
  }

  private get relayUrl(): string {
    return this.config.relayUrl || FLUX_CLOUD_URL;
  }

  /** True when local instance credentials are known, regardless of whether they're currently in use. */
  private hasLocalCredentials(): boolean {
    return Boolean(this.config.localBaseUrl && this.config.localAccessToken);
  }

  /** Whether the local instance should be tried before the cloud, based on known credentials and network status. */
  private shouldPreferLocal(): boolean {
    return this.hasLocalCredentials() && this.isOnLocalNetwork !== false;
  }

  private preferredTransport(): TransportMode {
    return this.shouldPreferLocal() ? 'local' : 'relay';
  }

  private async ensureLocalSession(): Promise<void> {
    if (this.hasLocalCredentials() || this.isOnLocalNetwork === false || !this.config.instanceId || !(this.authSession?.token || this.config.accessToken)) return;
    if (this.localSessionExchange) return await this.localSessionExchange;

    const baseUrl = this.config.localBaseUrl || DEFAULT_LOCAL_BASE_URL;
    this.localSessionExchange = (async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1500);
      try {
        const response = await this.fetchImpl(new URL('/health', baseUrl), { signal: controller.signal });
        if (!response.ok) return;
      } catch {
        this.diagnostic('info', 'transport.local.unavailable', `Local instance is not reachable at ${baseUrl}`);
        return;
      } finally {
        clearTimeout(timeout);
      }

      try {
        await this.exchangeCloudSessionForLocal(baseUrl);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Local session exchange failed';
        this.diagnostic('warn', 'transport.local.exchange.failed', message);
      }
    })().finally(() => {
      this.localSessionExchange = null;
    });
    await this.localSessionExchange;
  }

  /**
   * Runs `localCall` against the local Home Assistant instance first when it looks reachable,
   * falling back to `cloudCall` (the cloud relay) if the local attempt fails or isn't available.
   * Updates the transport mode reported by `getTransportMode()` to reflect whichever path served the request.
   */
  private async withLocalFallback<T>(action: string, localCall: (baseUrl: string, token: string) => Promise<T>, cloudCall: () => Promise<T>): Promise<T> {
    await this.ensureLocalSession();
    if (this.shouldPreferLocal()) {
      try {
        const result = await localCall(this.config.localBaseUrl!, this.config.localAccessToken!);
        this.activeTransport = 'local';
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : `Local ${action} failed`;
        this.diagnostic('warn', 'transport.local.fallback', `Local ${action} failed (${message}); falling back to cloud relay`);
        this.config.localAccessToken = undefined;
        this.config.localUseLan = false;
        await this.persistState();
        await this.ensureLocalSession();
        if (this.shouldPreferLocal()) {
          try {
            const result = await localCall(this.config.localBaseUrl!, this.config.localAccessToken!);
            this.activeTransport = 'local';
            return result;
          } catch (retryError) {
            const retryMessage = retryError instanceof Error ? retryError.message : `Local ${action} retry failed`;
            this.diagnostic('warn', 'transport.local.retry.failed', retryMessage);
          }
        }
      }
    }
    const result = await cloudCall();
    this.activeTransport = 'relay';
    return result;
  }

  public onStateChange(listener: (state: ConnectionState) => void): () => void {
    this.listeners.push(listener);
    return () => { this.listeners = this.listeners.filter((item) => item !== listener); };
  }

  public getState(): ConnectionState { return this.state; }
  public getAuthSession(): AuthSession | null { return this.authSession; }
  /** Which transport is currently favoured/in use: 'local' for the on-network Home Assistant instance, 'relay' for the cloud. */
  public getTransportMode(): TransportMode { return this.activeTransport; }

  public async register(credentials: AuthCredentials): Promise<AuthSession> {
    return await this.authenticate('/api/auth/register', { email: credentials.username.trim(), password: credentials.password, label: credentials.displayName?.trim() || undefined }, 'register');
  }

  public async login(credentials: AuthCredentials): Promise<AuthSession> {
    return await this.authenticate('/api/auth/login', { email: credentials.username.trim(), password: credentials.password, instance_id: credentials.instanceId }, 'login');
  }

  /**
   * Signs in directly against a Home Assistant instance on the local network (e.g.
   * `http://homeassistant.local:8080`) using the same username/password as the cloud
   * account, and switches the client into LAN transport mode. Cloud relay sessions are
   * not valid for local requests and vice versa, so this performs its own login call
   * against the instance's local API.
   */
  public async loginLocal(baseUrl: string, credentials: AuthCredentials): Promise<void> {
    const response = await this.fetchImpl(new URL('/api/auth/login', baseUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: credentials.username.trim(), password: credentials.password }),
    });
    const payload = await response.json() as { message?: string; data?: { user?: string; token?: string } };
    if (!response.ok || !payload.data?.token) throw new Error(payload.message || 'Local sign-in failed');
    this.config.localBaseUrl = baseUrl;
    this.config.localAccessToken = payload.data.token;
    this.config.localUseLan = true;
    await this.persistState();
    this.diagnostic('info', 'transport.local.login', `Signed in to local instance at ${baseUrl}`);
  }

  /**
   * Exchanges the active cloud session for a short-lived local token through the authenticated
   * relay tunnel. The token is then used only for requests directly to `baseUrl`.
   */
  public async exchangeCloudSessionForLocal(baseUrl: string): Promise<void> {
    const instanceId = this.config.instanceId?.trim();
    const accessToken = this.authSession?.token || this.config.accessToken;
    if (!instanceId || !accessToken) throw new Error('Sign in to the cloud before connecting locally');

    const response = await this.fetchImpl(new URL('/api/auth/local-session', this.relayUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
        'x-instance-id': instanceId,
      },
    });
    const payload = await response.json() as { message?: string; data?: { token?: string } };
    if (!response.ok || !payload.data?.token) throw new Error(payload.message || 'Local session exchange failed');

    this.config.localBaseUrl = baseUrl;
    this.config.localAccessToken = payload.data.token;
    this.config.localUseLan = true;
    this.activeTransport = 'local';
    await this.persistState();
    this.diagnostic('info', 'transport.local.exchange', `Cloud session exchanged for a local token at ${baseUrl}`);
  }

  public async logout(): Promise<void> {
    this.reconnectEnabled = false;
    this.authSession = null;
    this.config.accessToken = undefined;
    this.config.localAccessToken = undefined;
    this.config.localUseLan = false;
    this.activeTransport = 'relay';
    for (const pending of this.pending.values()) pending.reject(new Error('Signed out'));
    this.pending.clear();
    if (this.socket) {
      this.socket.close(1000, 'Signed out');
      this.socket = null;
    }
    this.setState('disconnected');
    await this.persistState();
  }

  private async authenticate(path: string, body: Record<string, string | undefined>, action: string): Promise<AuthSession> {
    const response = await this.fetchImpl(new URL(path, this.relayUrl), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const payload = await response.json() as { message?: string; data?: AuthSession };
    const session = payload.data;
    if (!response.ok || !session?.token || !session.instanceId) throw new Error(payload.message || `${action} failed`);
    this.config.instanceId = session.instanceId;
    this.config.accessToken = session.token;
    this.authSession = session;
    await this.persistState();
    return session;
  }

  public async connect(): Promise<void> {
    this.reconnectEnabled = true;
    const hasCloudCredentials = Boolean(this.relayUrl.trim() && this.config.instanceId?.trim() && (this.authSession?.token || this.config.accessToken));
    if (!hasCloudCredentials) {
      if (this.hasLocalCredentials()) {
        this.diagnostic('info', 'transport.local', 'No cloud session configured; using the local network instance only');
        this.activeTransport = 'local';
        this.setState('connected');
        return;
      }
      throw new Error('Relay URL and instance ID are required before connecting');
    }
    if (this.socket?.readyState === 1) return;
    const relayUrl = this.relayUrl.trim();
    const instanceId = this.config.instanceId?.trim();
    if (!relayUrl || !instanceId) {
      throw new Error('Relay URL and instance ID are required before connecting');
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
          'x-instance-id': this.config.instanceId,
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
    const socket = new SocketCtor(buildRelaySocketUrl(this.relayUrl, this.config.instanceId, ticket)) as WebSocketLike;
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
    const request: RequestEnvelope<ProxyRequest> = { type: 'proxy_request', instanceId: this.config.instanceId, requestId, payload, ts: Date.now() };
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
    return await this.withLocalFallback(
      'request',
      async (baseUrl, token) => {
        const response = await this.fetchImpl(new URL(path, baseUrl), { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
        const text = await response.text();
        if (!response.ok) throw new Error(text || `Request failed: ${response.status}`);
        return text ? JSON.parse(text) as T : undefined as T;
      },
      async () => {
        const token = this.authSession?.token || this.config.accessToken;
        const response = await this.fetchImpl(new URL(path, this.relayUrl), { method, headers: { 'Content-Type': 'application/json', 'x-instance-id': this.config.instanceId, Authorization: `Bearer ${token || ''}` }, body: body === undefined ? undefined : JSON.stringify(body) });
        const text = await response.text();
        if (!response.ok) throw new Error(text || `Request failed: ${response.status}`);
        return text ? JSON.parse(text) as T : undefined as T;
      },
    );
  }

  public async search(params: SearchRequest): Promise<SearchResult[]> {
    return await this.withLocalFallback(
      'search',
      async (baseUrl, token) => {
        const url = new URL('/api/search', baseUrl);
        url.searchParams.set('q', params.q);
        url.searchParams.set('limit', String(params.limit ?? 20));
        const response = await this.fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } });
        if (!response.ok) throw new Error(`Search failed: ${response.status}`);
        return await response.json() as SearchResult[];
      },
      async () => {
        const payload = await this.sendRelayRequest<ProxyResponse<SearchResult[]>>({ method: 'GET', path: '/api/search', query: { q: params.q, limit: String(params.limit ?? 20) }, headers: { Authorization: `Bearer ${this.authSession?.token || this.config.accessToken || ''}` } });
        if (!payload || payload.status >= 400) throw new Error('Search failed');
        return (payload.body ?? payload.data ?? []) as SearchResult[];
      },
    );
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
    return await this.withLocalFallback(
      'upload',
      async (baseUrl, token) => {
        const url = new URL('/api/files/upload', baseUrl);
        url.searchParams.set('path', uploadPath);
        const form = new FormData();
        form.append('file', await bytesToBlob(bytes, getMimeType(fileName)), fileName);
        const response = await this.fetchImpl(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          body: form,
        });
        const payload = await response.json() as { data?: string; message?: string };
        if (!response.ok) throw new Error(payload.message || `Upload failed: ${response.status}`);
        return { path: payload.data || uploadPath };
      },
      async () => {
        const payload = await this.sendRelayRequest<ProxyResponse<{ path: string }>>({ method: 'POST', path: '/api/files/upload', query: { path: uploadPath }, headers: { Authorization: `Bearer ${this.authSession?.token || this.config.accessToken || ''}` }, body: { file_name: fileName, content_b64: encodeBase64(bytes) } });
        if (!payload || payload.status >= 400) throw new Error('Upload failed');
        return (payload.body ?? payload.data ?? { path: uploadPath }) as { path: string };
      },
    );
  }

  public async downloadFile(path: string, options: DownloadOptions = {}): Promise<Blob> {
    const parseDownload = async (response: Response): Promise<Blob> => {
      if (!response.ok) throw new Error(`Download failed: ${response.status}`);
      if (!response.headers.get('content-type')?.includes('application/json')) return await response.blob();
      const payload = await response.json() as { content_b64?: string; mime_type?: string; file_name?: string };
      if (!payload.content_b64) throw new Error('Download response did not include file content');
      const bytes = decodeBase64(payload.content_b64);
      return await bytesToBlob(bytes, payload.mime_type || 'application/octet-stream');
    };
    return await this.withLocalFallback(
      'download',
      async (baseUrl, token) => {
        const url = new URL('/api/files/download', baseUrl);
        url.searchParams.set('path', path);
        if (options.user) url.searchParams.set('user', options.user);
        const response = await this.fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } });
        return await parseDownload(response);
      },
      async () => {
        const token = this.authSession?.token || this.config.accessToken;
        const url = new URL('/api/files/download', this.relayUrl);
        url.searchParams.set('instance_id', this.config.instanceId);
        url.searchParams.set('path', path);
        if (options.user) url.searchParams.set('user', options.user);
        const response = await this.fetchImpl(url, { headers: { Authorization: `Bearer ${token || ''}` } });
        return await parseDownload(response);
      },
    );
  }

  public async getConfig(): Promise<Record<string, unknown>> { return await this.httpRequest('/api/config', 'GET'); }

  public async disconnect(): Promise<void> {
    this.reconnectEnabled = false;
    if (this.socket) { this.socket.close(); this.socket = null; }
    this.setState('disconnected');
  }
}

export type FluxClientConstructor = typeof FluxClient;
