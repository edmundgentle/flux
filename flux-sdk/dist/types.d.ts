export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';
export type TransportMode = 'relay' | 'local';
export type DiagnosticEvent = {
    timestamp: number;
    level: 'info' | 'warn' | 'error';
    transport: TransportMode;
    event: string;
    message: string;
};
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type RequestEnvelope<T = unknown> = {
    type: 'proxy_request';
    instanceId: string;
    requestId: string;
    payload: T;
    ts: number;
};
export type ResponseEnvelope<T = unknown> = {
    type: 'proxy_response' | 'error';
    instanceId?: string;
    requestId?: string;
    payload?: T;
    error?: string;
    ts?: number;
};
export type ProxyRequest = {
    method: HttpMethod;
    path: string;
    query?: Record<string, string | string[] | undefined>;
    headers?: Record<string, string>;
    body?: unknown;
    user?: string;
};
export type ProxyResponse<T = unknown> = {
    status: number;
    body?: T;
    data?: T;
    headers?: Record<string, string>;
    text?: string;
};
export type VisionTag = {
    label: string;
    confidence: number;
    source: 'onnx' | 'metadata' | 'manual';
    bbox?: [number, number, number, number];
};
export type FaceEmbedding = {
    id?: string;
    embedding: number[];
    score?: number;
    source: 'face';
};
export type SearchResult = {
    path: string;
    file_name: string;
    content_preview: string;
    tags: string[];
    faces: string[];
    latitude?: number | null;
    longitude?: number | null;
    date_created: number;
    owner: string;
    allowed_users: string[];
    score: number;
};
export type SearchRequest = {
    q: string;
    limit?: number;
    user?: string;
};
export type UploadProgress = {
    loaded: number;
    total: number;
    percent: number;
};
export type AuthStorage = {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
    removeItem(key: string): Promise<void>;
};
/**
 * Reports whether the device currently appears to be on the same local network as the
 * Home Assistant instance (e.g. connected to home Wi-Fi). Return `null` when unknown -
 * the SDK will still optimistically try the local instance first. Return `false` only
 * when confident the local instance is unreachable (e.g. on cellular data), so the SDK
 * skips straight to the cloud relay instead of waiting on a doomed local request.
 */
export type NetworkMonitor = {
    isOnLocalNetwork(): boolean | null;
    subscribe?(listener: (isOnLocalNetwork: boolean | null) => void): () => void;
};
export type FeatureConfig = {
    /** Overrides the built-in Flux cloud relay URL. Intended for testing only; end users cannot configure this. */
    relayUrl?: string;
    instanceId: string;
    instanceToken?: string;
    accessToken?: string;
    localBaseUrl?: string;
    localAccessToken?: string;
    localUseLan?: boolean;
    websocketCtor?: new (url: string, protocols?: string | string[]) => WebSocketLike;
    fetchImpl?: typeof fetch;
    onDiagnostic?: (event: DiagnosticEvent) => void;
    autoConnect?: boolean;
    /** Optional persistent storage adapter (e.g. AsyncStorage) used to remember the signed-in session between app launches. */
    storage?: AuthStorage;
    /** Key used to store the persisted session in `storage`. */
    storageKey?: string;
    /** Optional network reachability adapter (e.g. backed by NetInfo) used to decide whether to try the local instance first. */
    networkMonitor?: NetworkMonitor;
};
export type AuthCredentials = {
    username: string;
    password: string;
    displayName?: string;
    instanceId?: string;
};
export type AuthInstance = {
    instanceId: string;
    label: string;
};
export type AuthSession = {
    user: string;
    token: string;
    instanceId: string;
    tunnelToken?: string;
    label?: string;
    instances?: AuthInstance[];
};
export type AuthApiResponse = {
    success: boolean;
    message: string;
    data?: AuthSession;
};
export interface WebSocketLike {
    readyState: number;
    onopen: ((event: unknown) => void) | null;
    onmessage: ((event: {
        data: string | ArrayBuffer | Blob;
    }) => void) | null;
    onerror: ((event: unknown) => void) | null;
    onclose: ((event: {
        code?: number;
        reason?: string;
        wasClean?: boolean;
    }) => void) | null;
    send(data: string): void;
    close(code?: number, reason?: string): void;
}
export type FileUploadOptions = {
    path?: string;
    directory?: string;
    user?: string;
    onProgress?: (progress: UploadProgress) => void;
};
export type DownloadOptions = {
    user?: string;
    onProgress?: (received: number, total?: number) => void;
};
