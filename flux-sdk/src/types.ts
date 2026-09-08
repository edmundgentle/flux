export type ConnectionState =
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected';

export type TransportMode = 'relay' | 'local';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export type RequestEnvelope<T = unknown> = {
  type: 'proxy_request';
  tenantId: string;
  requestId: string;
  payload: T;
  ts: number;
};

export type ResponseEnvelope<T = unknown> = {
  type: 'proxy_response' | 'error';
  tenantId?: string;
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

export type FeatureConfig = {
  relayUrl: string;
  tenantId: string;
  tenantToken?: string;
  accessToken?: string;
  localBaseUrl?: string;
  localAccessToken?: string;
  localUseLan?: boolean;
  websocketCtor?: new (url: string, protocols?: string | string[]) => WebSocketLike;
  fetchImpl?: typeof fetch;
  autoConnect?: boolean;
};

export type AuthCredentials = {
  username: string;
  password: string;
  displayName?: string;
  tenantId?: string;
};

export type AuthTenant = {
  tenantId: string;
  label: string;
};

export type AuthSession = {
  user: string;
  token: string;
  tenantId: string;
  tunnelToken?: string;
  label?: string;
  tenants?: AuthTenant[];
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
  onclose: ((event: unknown) => void) | null;
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
