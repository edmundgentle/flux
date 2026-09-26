import { FeatureConfig, SearchRequest, SearchResult, ConnectionState, FileUploadOptions, DownloadOptions, ListFilesOptions, DirectoryListing, AuthCredentials, AuthSession, TransportMode, FacePerson, FacePersonDetail, PhotoFace, FaceSuggestion, FaceContact, FaceLabel } from './types.js';
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
    private localProbe;
    private sessionMint;
    private channel;
    private sequence;
    private sequenceReserved;
    /** Which transport actually served the most recent (or currently in-flight) request. */
    private activeTransport;
    /** Resolves once any previously persisted session has been restored from storage. */
    readonly ready: Promise<void>;
    private diagnostic;
    constructor(config: FeatureConfig);
    private restoreSession;
    private persistState;
    /** True once an access token has been issued by the instance (via login, register, or restored from storage). */
    isLoggedIn(): boolean;
    /** The instance-issued token that authorizes data access on both the LAN and relay transports. */
    private accessToken;
    /** Headers for a request routed through the cloud: relay admission plus the instance token. */
    private cloudHeaders;
    private get relayUrl();
    /** True when a local instance address is known and we hold a token to present to it. */
    private hasLocalCredentials;
    /** The AES-GCM channel used for LAN requests, derived from the instance-issued token. */
    private secureChannel;
    private nextSequence;
    /**
     * Sends a request to the local instance inside an encrypted envelope. Nothing readable -
     * including the access token - is exposed on the LAN.
     */
    private secureLocalRequest;
    private secureLocalJson;
    /** Whether the local instance should be tried before the cloud, based on known credentials and network status. */
    private shouldPreferLocal;
    private preferredTransport;
    /**
     * Probes the local instance once so the LAN transport is only preferred when it is actually
     * reachable. No credential exchange is involved - the token already works on both transports.
     */
    private ensureLocalReachable;
    /**
     * Obtains an instance-issued access token through the relay when we don't have one yet - for
     * example when the instance was offline at login, or the previous token expired or was revoked.
     */
    private ensureInstanceSession;
    /**
     * Runs `localCall` against the local Home Assistant instance first when it looks reachable,
     * falling back to `cloudCall` (the cloud relay) if the local attempt fails or isn't available.
     * Both paths present the same instance-issued token.
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
     * Points the client at a Home Assistant instance on the local network (e.g.
     * `http://homeassistant.local:3589`) and switches into LAN transport mode. No sign-in is
     * needed: the access token issued at cloud login is accepted by the instance directly.
     */
    useLocalInstance(baseUrl: string): Promise<void>;
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
    /**
     * Like `downloadFile`, but returns a base64 data URI string instead of a Blob. Useful on
     * React Native, where Blobs can't be constructed directly from raw bytes but a data URI
     * can be handed straight to `<Image>` or similar.
     */
    downloadFileAsDataUri(path: string, options?: DownloadOptions): Promise<string>;
    /** Lists files and folders in a directory relative to the signed-in user's workspace (e.g. `/Notes`). */
    listFiles(path?: string, options?: ListFilesOptions): Promise<DirectoryListing>;
    deleteFile(path: string): Promise<void>;
    getConfig(): Promise<Record<string, unknown>>;
    /** Calls a `/api/faces/*` endpoint and unwraps its `{ success, message, data }` response. */
    private facesRequest;
    /** People found in the signed-in user's photos: labelled people first, then by photo count. */
    listPeople(): Promise<FacePerson[]>;
    getPerson(personId: string): Promise<FacePersonDetail>;
    getPhotoFaces(path: string): Promise<PhotoFace[]>;
    /** Pairs of people that look alike, most similar first. */
    getFaceSuggestions(limit?: number): Promise<FaceSuggestion[]>;
    /** The user's flux-people contacts, for labelling people. */
    listFaceContacts(): Promise<FaceContact[]>;
    /**
     * Names a person, optionally linking a contact. Another person already carrying the same
     * contact (or name) is merged in. Pass empty values to clear the label.
     */
    labelPerson(personId: string, label: FaceLabel): Promise<string>;
    /** Confirms that `sourceIds` are the same person as `targetId`. */
    mergePeople(targetId: string, sourceIds: string[]): Promise<void>;
    /** Records that two people are different, so they're no longer suggested. */
    rejectFaceSuggestion(personA: string, personB: string): Promise<void>;
    /** Moves a face to another person, or into a new person of its own when `personId` is null. */
    assignFace(faceId: string, personId: string | null): Promise<string>;
    disconnect(): Promise<void>;
}
export type FluxClientConstructor = typeof FluxClient;
