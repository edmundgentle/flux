import { FeatureConfig, SearchRequest, SearchResult, ConnectionState, RequestEnvelope, ResponseEnvelope, ProxyRequest, ProxyResponse, FileUploadOptions, DownloadOptions, ListFilesOptions, DirectoryListing, WebSocketLike, AuthCredentials, AuthSession, TransportMode, DiagnosticEvent, AuthStorage, NetworkMonitor, HttpMethod, FacePerson, FacePersonDetail, PhotoFace, FaceSuggestion, FaceContact, FaceLabel } from './types.js';
import { buildRelaySocketUrl, getMimeType, sleep, uuid, safeJsonParse } from './utils.js';
import { SecureChannel, SecureRequest, SecureResponse, KEY_ID_HEADER, buildMultipartBody } from './secure.js';

/** The Flux cloud relay URL. Fixed and not user-customisable; only overridable for tests. */
export const FLUX_CLOUD_URL = 'https://flux-relay-fvnyy.ondigitalocean.app';

const DEFAULT_STORAGE_KEY = 'flux.auth.session';
const DEFAULT_LOCAL_BASE_URL = 'http://homeassistant.local:3589';

/**
 * Sequence numbers must never repeat for a given key, so they are reserved in blocks and only
 * persisted when a block runs out - one storage write per block instead of one per request.
 */
const SEQUENCE_RESERVE_BLOCK = 1000;

type PersistedAuthState = {
  session?: AuthSession;
  local?: { baseUrl: string };
  sequence?: number;
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
 * Builds a Blob from raw bytes. Works on web and Node; React Native's Blob implementation
 * doesn't support constructing a Blob directly from an ArrayBuffer/ArrayBufferView, so
 * native callers that need image bytes should use `downloadFileAsDataUri` instead.
 */
function bytesToBlob(bytes: Uint8Array, mimeType: string): Blob {
  return new Blob([bytes.buffer as ArrayBuffer], { type: mimeType });
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
  private localProbe: Promise<void> | null = null;
  private sessionMint: Promise<void> | null = null;
  private channel: SecureChannel | null = null;
  private sequence = 0;
  private sequenceReserved = 0;
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
        this.config.keyId = state.session.keyId;
        this.config.relaySession = state.session.relaySession;
        this.config.instanceId = state.session.instanceId;
      }
      if (typeof state?.sequence === 'number') {
        this.sequence = state.sequence;
        this.sequenceReserved = state.sequence;
      }
      if (state?.local) {
        this.config.localBaseUrl = state.local.baseUrl;
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
      local: this.config.localUseLan && this.config.localBaseUrl
        ? { baseUrl: this.config.localBaseUrl }
        : undefined,
      sequence: this.sequenceReserved || undefined,
    };
    if (!state.session && !state.local) {
      await this.storage.removeItem(this.storageKey);
      return;
    }
    await this.storage.setItem(this.storageKey, JSON.stringify(state));
  }

  /** True once an access token has been issued by the instance (via login, register, or restored from storage). */
  public isLoggedIn(): boolean {
    return Boolean(this.accessToken());
  }

  /** The instance-issued token that authorizes data access on both the LAN and relay transports. */
  private accessToken(): string | undefined {
    return this.authSession?.token || this.config.accessToken;
  }

  /** Headers for a request routed through the cloud: relay admission plus the instance token. */
  private cloudHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return {
      'x-instance-id': this.config.instanceId,
      'x-relay-session': this.config.relaySession || '',
      Authorization: `Bearer ${this.accessToken() || ''}`,
      ...extra,
    };
  }

  private get relayUrl(): string {
    return this.config.relayUrl || FLUX_CLOUD_URL;
  }

  /** True when a local instance address is known and we hold a token to present to it. */
  private hasLocalCredentials(): boolean {
    return Boolean(this.config.localBaseUrl && this.config.localUseLan && this.secureChannel());
  }

  /** The AES-GCM channel used for LAN requests, derived from the instance-issued token. */
  private secureChannel(): SecureChannel | null {
    const token = this.accessToken();
    const keyId = this.config.keyId;
    if (!token || !keyId) return null;
    if (!this.channel || this.channel.keyId !== keyId) this.channel = new SecureChannel(token, keyId);
    return this.channel;
  }

  private async nextSequence(): Promise<number> {
    this.sequence += 1;
    if (this.sequence > this.sequenceReserved) {
      this.sequenceReserved = this.sequence + SEQUENCE_RESERVE_BLOCK;
      await this.persistState();
    }
    return this.sequence;
  }

  /**
   * Sends a request to the local instance inside an encrypted envelope. Nothing readable -
   * including the access token - is exposed on the LAN.
   */
  private async secureLocalRequest(request: SecureRequest): Promise<SecureResponse> {
    const channel = this.secureChannel();
    const baseUrl = this.config.localBaseUrl;
    if (!channel || !baseUrl) throw new Error('No local session key is available');

    const send = async (): Promise<SecureResponse> => {
      const seq = await this.nextSequence();
      const envelope = await channel.sealRequest(seq, request);
      const response = await this.fetchImpl(new URL('/api/secure', baseUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', [KEY_ID_HEADER]: channel.keyId },
        body: envelope as BodyInit,
      });
      if (!response.ok) throw new Error(`Local instance rejected the envelope (${response.status})`);
      return await channel.openResponse(seq, new Uint8Array(await response.arrayBuffer()));
    };

    const result = await send();
    if (result.status !== 409) return result;

    // The instance restarted and advanced its replay window past our counter; resynchronise.
    const payload = safeJsonParse<{ next_seq?: number }>(new TextDecoder().decode(result.body));
    if (typeof payload?.next_seq !== 'number') return result;
    this.sequence = payload.next_seq;
    this.sequenceReserved = 0;
    this.diagnostic('info', 'transport.local.resync', `Resynchronised envelope sequence to ${payload.next_seq}`);
    return await send();
  }

  private async secureLocalJson<T>(request: SecureRequest): Promise<T> {
    const result = await this.secureLocalRequest(request);
    const text = new TextDecoder().decode(result.body);
    if (result.status >= 400) throw new Error(text || `Request failed: ${result.status}`);
    return text ? JSON.parse(text) as T : undefined as T;
  }

  /** Whether the local instance should be tried before the cloud, based on known credentials and network status. */
  private shouldPreferLocal(): boolean {
    return this.hasLocalCredentials() && this.isOnLocalNetwork !== false;
  }

  private preferredTransport(): TransportMode {
    return this.shouldPreferLocal() ? 'local' : 'relay';
  }

  /**
   * Probes the local instance once so the LAN transport is only preferred when it is actually
   * reachable. No credential exchange is involved - the token already works on both transports.
   */
  private async ensureLocalReachable(): Promise<void> {
    if (this.config.localUseLan || this.isOnLocalNetwork === false || !this.accessToken()) return;
    if (this.localProbe) return await this.localProbe;

    const baseUrl = this.config.localBaseUrl || DEFAULT_LOCAL_BASE_URL;
    this.localProbe = (async () => {
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

      this.config.localBaseUrl = baseUrl;
      this.config.localUseLan = true;
      await this.persistState();
      this.diagnostic('info', 'transport.local.available', `Local instance is reachable at ${baseUrl}`);
    })().finally(() => {
      this.localProbe = null;
    });
    await this.localProbe;
  }

  /**
   * Obtains an instance-issued access token through the relay when we don't have one yet - for
   * example when the instance was offline at login, or the previous token expired or was revoked.
   */
  private async ensureInstanceSession(): Promise<void> {
    const relaySession = this.config.relaySession;
    const instanceId = this.config.instanceId?.trim();
    if (this.accessToken() || !relaySession || !instanceId) return;
    if (this.sessionMint) return await this.sessionMint;

    this.sessionMint = (async () => {
      const response = await this.fetchImpl(new URL('/api/auth/session', this.relayUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-relay-session': relaySession, 'x-instance-id': instanceId },
      });
      const payload = await response.json() as { message?: string; data?: { token?: string; keyId?: string; expiresAt?: string; user?: string } };
      const token = payload.data?.token;
      if (!response.ok || !token) throw new Error(payload.message || 'The instance could not issue an access token');
      this.config.accessToken = token;
      this.config.keyId = payload.data?.keyId;
      this.channel = null;
      this.authSession = {
        ...this.authSession,
        user: payload.data?.user || this.authSession?.user || '',
        token,
        keyId: payload.data?.keyId,
        expiresAt: payload.data?.expiresAt,
        instanceId,
        relaySession,
      };
      await this.persistState();
      this.diagnostic('info', 'auth.session.minted', 'Received a new access token from the instance');
    })().finally(() => {
      this.sessionMint = null;
    });
    await this.sessionMint;
  }

  /**
   * Runs `localCall` against the local Home Assistant instance first when it looks reachable,
   * falling back to `cloudCall` (the cloud relay) if the local attempt fails or isn't available.
   * Both paths present the same instance-issued token.
   * Updates the transport mode reported by `getTransportMode()` to reflect whichever path served the request.
   */
  private async withLocalFallback<T>(action: string, localCall: () => Promise<T>, cloudCall: () => Promise<T>): Promise<T> {
    await this.ensureInstanceSession();
    await this.ensureLocalReachable();
    if (this.shouldPreferLocal()) {
      try {
        const result = await localCall();
        this.activeTransport = 'local';
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : `Local ${action} failed`;
        this.diagnostic('warn', 'transport.local.fallback', `Local ${action} failed (${message}); falling back to cloud relay`);
        this.config.localUseLan = false;
        await this.persistState();
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
   * Points the client at a Home Assistant instance on the local network (e.g.
   * `http://homeassistant.local:3589`) and switches into LAN transport mode. No sign-in is
   * needed: the access token issued at cloud login is accepted by the instance directly.
   */
  public async useLocalInstance(baseUrl: string): Promise<void> {
    await this.ensureInstanceSession();
    if (!this.secureChannel()) throw new Error('Sign in before connecting to the local instance');

    const previousBaseUrl = this.config.localBaseUrl;
    this.config.localBaseUrl = baseUrl;
    try {
      const result = await this.secureLocalRequest({ method: 'GET', path: '/api/auth/session' });
      if (result.status >= 400) throw new Error(`The local instance rejected the session (${result.status})`);
    } catch (error) {
      this.config.localBaseUrl = previousBaseUrl;
      throw error;
    }

    this.config.localUseLan = true;
    this.activeTransport = 'local';
    await this.persistState();
    this.diagnostic('info', 'transport.local.ready', `Using the local instance at ${baseUrl}`);
  }

  public async logout(): Promise<void> {
    this.reconnectEnabled = false;
    // Revoke the token at the instance so it cannot be replayed if it was captured on the LAN.
    try {
      if (this.accessToken()) await this.httpRequest('/api/auth/logout', 'POST');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Remote sign-out failed';
      this.diagnostic('warn', 'auth.logout.remote.failed', message);
    }
    this.authSession = null;
    this.config.accessToken = undefined;
    this.config.keyId = undefined;
    this.config.relaySession = undefined;
    this.config.localUseLan = false;
    this.channel = null;
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
    if (!response.ok || !session?.instanceId) throw new Error(payload.message || `${action} failed`);
    this.config.instanceId = session.instanceId;
    this.config.relaySession = session.relaySession;
    this.config.accessToken = session.token || undefined;
    this.config.keyId = session.keyId;
    this.channel = null;
    this.authSession = session;
    await this.persistState();
    // The instance may have been offline during login; retry so the caller ends up with a token.
    if (!session.token) await this.ensureInstanceSession();
    return this.authSession;
  }

  public async connect(): Promise<void> {
    this.reconnectEnabled = true;
    const hasCloudCredentials = Boolean(this.relayUrl.trim() && this.config.instanceId?.trim() && this.config.relaySession);
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
    this.setState('connecting');
    let ticketResponse: Response;
    try {
      ticketResponse = await this.fetchImpl(new URL('/api/auth/ws-ticket', relayUrl), {
        method: 'POST',
        headers: this.cloudHeaders({ 'Content-Type': 'application/json' }),
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
      async () => await this.secureLocalJson<T>({
        method,
        path,
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : new TextEncoder().encode(JSON.stringify(body)),
      }),
      async () => {
        const response = await this.fetchImpl(new URL(path, this.relayUrl), { method, headers: this.cloudHeaders({ 'Content-Type': 'application/json' }), body: body === undefined ? undefined : JSON.stringify(body) });
        const text = await response.text();
        if (!response.ok) throw new Error(text || `Request failed: ${response.status}`);
        return text ? JSON.parse(text) as T : undefined as T;
      },
    );
  }

  public async search(params: SearchRequest): Promise<SearchResult[]> {
    return await this.withLocalFallback(
      'search',
      async () => await this.secureLocalJson<SearchResult[]>({
        method: 'GET',
        path: '/api/search',
        query: { q: params.q, limit: String(params.limit ?? 20) },
      }),
      async () => {
        const payload = await this.sendRelayRequest<ProxyResponse<SearchResult[]>>({ method: 'GET', path: '/api/search', query: { q: params.q, limit: String(params.limit ?? 20) }, headers: { Authorization: `Bearer ${this.accessToken() || ''}` } });
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
      async () => {
        const multipart = buildMultipartBody('file', fileName, getMimeType(fileName), bytes);
        const payload = await this.secureLocalJson<{ data?: string; message?: string }>({
          method: 'POST',
          path: '/api/files/upload',
          query: { path: uploadPath },
          headers: { 'content-type': multipart.contentType },
          body: multipart.body,
        });
        return { path: payload?.data || uploadPath };
      },
      async () => {
        const payload = await this.sendRelayRequest<ProxyResponse<{ path: string }>>({ method: 'POST', path: '/api/files/upload', query: { path: uploadPath }, headers: { Authorization: `Bearer ${this.accessToken() || ''}` }, body: { file_name: fileName, content_b64: encodeBase64(bytes) } });
        if (!payload || payload.status >= 400) throw new Error('Upload failed');
        return (payload.body ?? payload.data ?? { path: uploadPath }) as { path: string };
      },
    );
  }

  public async downloadFile(path: string, options: DownloadOptions = {}): Promise<Blob> {
    const parseDownload = async (response: Response): Promise<Blob> => {
      if (!response.ok) throw new Error(`Download failed: ${response.status}`);
      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) return await response.blob();

      // The relay wraps downloads in JSON containing base64 data, while the
      // local server serves JSON files (including contacts) as their raw body.
      // Read the body once and only unwrap it when it is actually a relay payload.
      const rawText = await response.text();
      let payload: { content_b64?: string; mime_type?: string; file_name?: string } | undefined;
      try {
        payload = JSON.parse(rawText) as typeof payload;
      } catch {
        // Preserve an unexpected JSON response as a file; callers can surface
        // a useful parse error rather than silently falling back to a preview.
      }

      if (payload?.content_b64) {
        const bytes = decodeBase64(payload.content_b64);
        return bytesToBlob(bytes, payload.mime_type || 'application/octet-stream');
      }

      return new Blob([rawText], { type: contentType });
    };
    return await this.withLocalFallback(
      'download',
      async () => {
        const result = await this.secureLocalRequest({
          method: 'GET',
          path: '/api/files/download',
          query: { path, ...(options.user ? { user: options.user } : {}) },
        });
        if (result.status >= 400) throw new Error(`Download failed: ${result.status}`);
        return bytesToBlob(result.body, result.headers['content-type'] || 'application/octet-stream');
      },
      async () => {
        const url = new URL('/api/files/download', this.relayUrl);
        url.searchParams.set('instance_id', this.config.instanceId);
        url.searchParams.set('path', path);
        if (options.user) url.searchParams.set('user', options.user);
        const response = await this.fetchImpl(url, { headers: this.cloudHeaders() });
        return await parseDownload(response);
      },
    );
  }

  /**
   * Like `downloadFile`, but returns a base64 data URI string instead of a Blob. Useful on
   * React Native, where Blobs can't be constructed directly from raw bytes but a data URI
   * can be handed straight to `<Image>` or similar.
   */
  public async downloadFileAsDataUri(path: string, options: DownloadOptions = {}): Promise<string> {
    const parseDataUri = async (response: Response): Promise<string> => {
      if (!response.ok) throw new Error(`Download failed: ${response.status}`);
      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        const payload = await response.json() as { content_b64?: string; mime_type?: string };
        if (!payload.content_b64) throw new Error('Download response did not include file content');
        return `data:${payload.mime_type || 'application/octet-stream'};base64,${payload.content_b64}`;
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      return `data:${contentType || 'application/octet-stream'};base64,${encodeBase64(bytes)}`;
    };
    return await this.withLocalFallback(
      'download',
      async () => {
        const result = await this.secureLocalRequest({
          method: 'GET',
          path: '/api/files/download',
          query: { path, ...(options.user ? { user: options.user } : {}) },
        });
        if (result.status >= 400) throw new Error(`Download failed: ${result.status}`);
        const contentType = result.headers['content-type'] || 'application/octet-stream';
        return `data:${contentType};base64,${encodeBase64(result.body)}`;
      },
      async () => {
        const url = new URL('/api/files/download', this.relayUrl);
        url.searchParams.set('instance_id', this.config.instanceId);
        url.searchParams.set('path', path);
        if (options.user) url.searchParams.set('user', options.user);
        const response = await this.fetchImpl(url, { headers: this.cloudHeaders() });
        return await parseDataUri(response);
      },
    );
  }

  /** Lists files and folders in a directory relative to the signed-in user's workspace (e.g. `/Notes`). */
  public async listFiles(path = '/', options: ListFilesOptions = {}): Promise<DirectoryListing> {
    const query: Record<string, string> = { path, recursive: String(options.recursive ?? false) };
    if (options.limit !== undefined) query.limit = String(options.limit);
    return await this.withLocalFallback(
      'list',
      async () => {
        const payload = await this.secureLocalJson<{ data?: DirectoryListing; message?: string }>({ method: 'GET', path: '/api/files/list', query });
        if (!payload?.data) throw new Error(payload?.message || 'List failed');
        return payload.data;
      },
      async () => {
        const payload = await this.sendRelayRequest<ProxyResponse<DirectoryListing>>({ method: 'GET', path: '/api/files/list', query, headers: { Authorization: `Bearer ${this.accessToken() || ''}` } });
        if (!payload || payload.status >= 400 || !payload.data) throw new Error('List failed');
        return payload.data;
      },
    );
  }

  public async deleteFile(path: string): Promise<void> {
    return await this.withLocalFallback(
      'delete',
      async () => {
        const result = await this.secureLocalRequest({ method: 'DELETE', path: '/api/files', query: { path } });
        if (result.status >= 400) throw new Error(`Delete failed: ${result.status}`);
      },
      async () => {
        const payload = await this.sendRelayRequest<ProxyResponse<unknown>>({
          method: 'DELETE',
          path: '/api/files',
          query: { path },
          headers: { Authorization: `Bearer ${this.accessToken() || ''}` },
        });
        if (!payload || payload.status >= 400) throw new Error('Delete failed');
      },
    );
  }

  public async getConfig(): Promise<Record<string, unknown>> { return await this.httpRequest('/api/config', 'GET'); }

  /** Calls a `/api/faces/*` endpoint and unwraps its `{ success, message, data }` response. */
  private async facesRequest<T>(method: HttpMethod, route: string, query?: Record<string, string>, body?: unknown): Promise<T> {
    const path = `/api/faces/${route}`;
    type FacesResponse = { success?: boolean; message?: string; data?: T };
    const unwrap = (status: number, payload: FacesResponse | undefined): T => {
      if (status >= 400 || !payload?.success) throw new Error(payload?.message || `Face request failed (${status})`);
      return payload.data as T;
    };
    return await this.withLocalFallback(
      'faces',
      async () => {
        const result = await this.secureLocalRequest({
          method,
          path,
          query,
          headers: { 'content-type': 'application/json' },
          body: body === undefined ? undefined : new TextEncoder().encode(JSON.stringify(body)),
        });
        const text = new TextDecoder().decode(result.body);
        return unwrap(result.status, safeJsonParse<FacesResponse>(text));
      },
      async () => {
        const payload = await this.sendRelayRequest<ProxyResponse<FacesResponse>>({ method, path, query, body, headers: { Authorization: `Bearer ${this.accessToken() || ''}` } });
        if (!payload) throw new Error('Face request failed');
        return unwrap(payload.status, payload.body ?? payload.data);
      },
    );
  }

  /** People found in the signed-in user's photos: labelled people first, then by photo count. */
  public async listPeople(): Promise<FacePerson[]> {
    return await this.facesRequest<FacePerson[]>('GET', 'people');
  }

  public async getPerson(personId: string): Promise<FacePersonDetail> {
    return await this.facesRequest<FacePersonDetail>('GET', 'person', { id: personId });
  }

  public async getPhotoFaces(path: string): Promise<PhotoFace[]> {
    return await this.facesRequest<PhotoFace[]>('GET', 'photo', { path });
  }

  /** Pairs of people that look alike, most similar first. */
  public async getFaceSuggestions(limit = 20): Promise<FaceSuggestion[]> {
    return await this.facesRequest<FaceSuggestion[]>('GET', 'suggestions', { limit: String(limit) });
  }

  /** The user's flux-people contacts, for labelling people. */
  public async listFaceContacts(): Promise<FaceContact[]> {
    return await this.facesRequest<FaceContact[]>('GET', 'contacts');
  }

  /**
   * Names a person, optionally linking a contact. Another person already carrying the same
   * contact (or name) is merged in. Pass empty values to clear the label.
   */
  public async labelPerson(personId: string, label: FaceLabel): Promise<string> {
    const result = await this.facesRequest<{ person_id: string }>('POST', 'label', undefined, {
      person_id: personId,
      name: label.name ?? null,
      contact_id: label.contactId ?? null,
    });
    return result.person_id;
  }

  /** Confirms that `sourceIds` are the same person as `targetId`. */
  public async mergePeople(targetId: string, sourceIds: string[]): Promise<void> {
    await this.facesRequest('POST', 'merge', undefined, { target_id: targetId, source_ids: sourceIds });
  }

  /** Records that two people are different, so they're no longer suggested. */
  public async rejectFaceSuggestion(personA: string, personB: string): Promise<void> {
    await this.facesRequest('POST', 'reject', undefined, { person_a: personA, person_b: personB });
  }

  /** Moves a face to another person, or into a new person of its own when `personId` is null. */
  public async assignFace(faceId: string, personId: string | null): Promise<string> {
    const result = await this.facesRequest<{ person_id: string }>('POST', 'assign', undefined, { face_id: faceId, person_id: personId });
    return result.person_id;
  }

  public async disconnect(): Promise<void> {
    this.reconnectEnabled = false;
    if (this.socket) { this.socket.close(); this.socket = null; }
    this.setState('disconnected');
  }
}

export type FluxClientConstructor = typeof FluxClient;
