export type ConnectionState =
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected';

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

/** Face bounding box, normalized to 0..1 of the upright image. */
export type FaceBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type FaceRef = {
  id: string;
  /** Absolute instance path of the photo; pass to `downloadFile`. */
  path: string;
  box: FaceBox;
  /** Upright pixel dimensions of the photo. */
  image_width: number;
  image_height: number;
  date_created: number;
};

/** An automatically grouped person. Unlabelled groups have a `null` name. */
export type FacePerson = {
  id: string;
  name: string | null;
  /** flux-people contact id, when labelled against a contact. */
  contact_id: string | null;
  face_count: number;
  photo_count: number;
  cover: FaceRef | null;
};

export type FacePersonDetail = FacePerson & {
  /** Newest photo first. */
  faces: FaceRef[];
};

export type PhotoFace = FaceRef & {
  person_id: string;
  person_name: string | null;
};

/** "Are these the same person?" - `person_b` is the labelled one when either is. */
export type FaceSuggestion = {
  person_a: FacePerson;
  person_b: FacePerson;
  similarity: number;
};

export type FaceContact = {
  id: string;
  name: string;
  path: string;
};

export type FaceLabel = {
  name?: string | null;
  contactId?: string | null;
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
  /** Access token issued by the Home Assistant instance. Authorizes data access on both transports. */
  accessToken?: string;
  /** Public id of the envelope key derived from `accessToken`, used for LAN requests. */
  keyId?: string;
  /** Cloud-issued session that admits requests to the relay. Never grants access to instance data. */
  relaySession?: string;
  localBaseUrl?: string;
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
  /** Issued by the Home Assistant instance; used for LAN and relayed requests alike. */
  token: string;
  /** Public id of the envelope key derived from `token`. */
  keyId?: string;
  /** Cloud session used solely to admit requests to the relay. */
  relaySession?: string;
  expiresAt?: string;
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
  onmessage: ((event: { data: string | ArrayBuffer | Blob }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: { code?: number; reason?: string; wasClean?: boolean }) => void) | null;
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

export type ListFilesOptions = {
  /** Include the contents of subdirectories. */
  recursive?: boolean;
  /** Maximum entries to return; the instance caps this at 5000. */
  limit?: number;
};

export type FileEntry = {
  name: string;
  /** Absolute instance path; pass to `downloadFile` / `deleteFile`. */
  path: string;
  /** Path relative to the user's workspace, e.g. `/Notes/note_1.md`. */
  relative_path: string;
  is_dir: boolean;
  size: number;
  /** Last modification time in Unix milliseconds. */
  modified_at: number | null;
};

export type DirectoryListing = {
  path: string;
  recursive: boolean;
  entries: FileEntry[];
  /** True when the entry limit was hit and the listing is incomplete. */
  truncated: boolean;
};
