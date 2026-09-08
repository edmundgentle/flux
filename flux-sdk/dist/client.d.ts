import { FeatureConfig, SearchRequest, SearchResult, ConnectionState, FileUploadOptions, DownloadOptions, AuthCredentials, AuthSession } from './types.js';
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
    constructor(config: FeatureConfig);
    onStateChange(listener: (state: ConnectionState) => void): () => void;
    getState(): ConnectionState;
    getAuthSession(): AuthSession | null;
    register(credentials: AuthCredentials): Promise<AuthSession>;
    login(credentials: AuthCredentials): Promise<AuthSession>;
    logout(): void;
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
