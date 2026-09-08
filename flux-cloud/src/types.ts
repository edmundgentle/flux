import type { WebSocket } from 'ws';

export type TenantId = string;

export type RelayMessageType =
  | 'hello'
  | 'ping'
  | 'pong'
  | 'proxy_request'
  | 'proxy_response'
  | 'error';

export type RelayEnvelope<T = unknown> = {
  type: RelayMessageType;
  tenantId?: TenantId;
  requestId?: string;
  payload?: T;
  error?: string;
  ts?: number;
};

export type ProxyRequest = {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  headers?: Record<string, string>;
  query?: Record<string, string | string[]>;
  body?: unknown;
  user?: string;
  userSignature?: string;
};

export type ProxyResponse = {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
  data?: unknown;
  text?: string;
};

export type TenantTunnel = {
  tenantId: TenantId;
  socket: WebSocket;
  tunnelToken: string;
  connectedAt: number;
  lastSeen: number;
};
