import { FeatureConfig, SearchRequest, SearchResult, ConnectionState, FileUploadOptions, DownloadOptions, AuthCredentials, AuthSession, TransportMode } from './types.js';
/** The Flux cloud relay URL. Fixed and not user-customisable; only overridable for tests. */
export declare const FLUX_CLOUD_URL = "https://flux-relay-fvnyy.ondigitalocean.app";
export declare class FluxClient {
    private config;
    private socket;
    private pending;
    private reconnectDelay;
    private state;
    private listeners;
    private fetchImpl;
    private authSession;
    private reconnectEnabled;
    private storage;
    private storageKey;
    private networkMonitor;
    private isOnLocalNetwork;
    private localSessionExchange;
    /** Which transport actually served the most recent (or currently in-flight) request. */
    private activeTransport;
    /** Resolves once any previously persisted session has been restored from storage. */
    readonly ready: Promise<void>;
    private diagnostic;
    constructor(config: FeatureConfig);
    private restoreSession;
    private persistState;
    /** True once a cloud or local session has been established (via login, register, loginLocal, or restored from storage). */
    isLoggedIn(): boolean;
    private get relayUrl();
    /** True when local instance credentials are known, regardless of whether they're currently in use. */
    private hasLocalCredentials;
    /** Whether the local instance should be tried before the cloud, based on known credentials and network status. */
    private shouldPreferLocal;
    private preferredTransport;
    private ensureLocalSession;
    /**
     * Runs `localCall` against the local Home Assistant instance first when it looks reachable,
     * falling back to `cloudCall` (the cloud relay) if the local attempt fails or isn't available.
     * Updates the transport mode reported by `getTransportMode()` to reflect whichever path served the request.
     */
    private withLocalFallback;
    onStateChange(listener: (state: ConnectionState) => void): () => void;
    getState(): ConnectionState;
    getAuthSession(): AuthSession | null;
    /** Which transport is currently favoured/in use: 'local' for the on-network Home Assistant instance, 'relay' for the cloud. */
    getTransportMode(): TransportMode;
    register(credentials: AuthCredentials): Promise<AuthSession>;
    login(credentials: AuthCredentials): Promise<AuthSession>;
    /**
     * Signs in directly against a Home Assistant instance on the local network (e.g.
     * `http://homeassistant.local:8080`) using the same username/password as the cloud
     * account, and switches the client into LAN transport mode. Cloud relay sessions are
     * not valid for local requests and vice versa, so this performs its own login call
     * against the instance's local API.
     */
    loginLocal(baseUrl: string, credentials: AuthCredentials): Promise<void>;
    /**
     * Exchanges the active cloud session for a short-lived local token through the authenticated
     * relay tunnel. The token is then used only for requests directly to `baseUrl`.
     */
    exchangeCloudSessionForLocal(baseUrl: string): Promise<void>;
    logout(): Promise<void>;
    private authenticate;
    connect(): Promise<void>;
    private retryConnect;
    private setState;
    private sendRelayRequest;
    private httpRequest;
    search(params: SearchRequest): Promise<SearchResult[]>;
    uploadFile(file: Blob | ArrayBuffer | Uint8Array, options?: FileUploadOptions): Promise<{
        path: string;
    }>;
    downloadFile(path: string, options?: DownloadOptions): Promise<Blob>;
    getConfig(): Promise<Record<string, unknown>>;
    disconnect(): Promise<void>;
}
export type FluxClientConstructor = typeof FluxClient;
