import express from 'express';
import crypto from 'node:crypto';
import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { loadConfig } from './config';
import { TunnelRegistry, sendEnvelope, isJsonEnvelope, parseProxyRequest, makeProxyResponse } from './relay';
import { ProxyRequest, RelayEnvelope, ProxyResponse } from './types';
import { TenantStore } from './tenants';

const config = loadConfig();
const registry = new TunnelRegistry();
const tenantStore = new TenantStore(config.databaseUrl);
const app = express();
app.set('trust proxy', process.env.TRUST_PROXY === 'true');
const wsTickets = new Map<string, { tenantId: string; user: string; expiresAt: number }>();
const rateLimitBuckets = new Map<string, { startedAt: number; count: number }>();

function rateLimit(windowMs: number, maxRequests: number): express.RequestHandler {
  return (req, res, next) => {
    const key = `${req.ip}:${req.path}`;
    const now = Date.now();
    const current = rateLimitBuckets.get(key);
    if (!current || now - current.startedAt >= windowMs) {
      rateLimitBuckets.set(key, { startedAt: now, count: 1 });
      next();
      return;
    }
    if (current.count >= maxRequests) {
      res.status(429).json({ success: false, message: 'Too many requests' });
      return;
    }
    current.count += 1;
    next();
  };
}

const authRateLimit = rateLimit(60_000, 10);
const rateLimitCleanup = setInterval(() => {
  const cutoff = Date.now() - 60_000;
  for (const [key, bucket] of rateLimitBuckets) {
    if (bucket.startedAt < cutoff) rateLimitBuckets.delete(key);
  }
}, 60_000);
rateLimitCleanup.unref();

function messageText(message: unknown): string {
  if (typeof message === 'string') return message;
  if (Buffer.isBuffer(message)) return message.toString('utf8');
  return '';
}

function signRelayUser(tunnelToken: string, tenantId: string, requestId: string, user: string): string {
  return crypto.createHmac('sha256', tunnelToken)
    .update(`${tenantId}\n${requestId}\n${user}`)
    .digest('hex');
}

app.use((req, res, next) => {
  const origin = req.header('origin');
  if (origin && (config.corsOrigins.includes('*') || config.corsOrigins.includes(origin))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Tenant-Id');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  }
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
});
app.use(express.json({ limit: '12mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

const requireAccessToken = async (req: express.Request, res: express.Response, next: express.NextFunction): Promise<void> => {
  const tenantId = typeof req.query.tenant_id === 'string' ? req.query.tenant_id : req.header('x-tenant-id');
  const authorization = req.header('authorization');
  const token = authorization?.replace(/^Bearer\s+/i, '');
  const user = tenantId && token ? await tenantStore.getAccessTokenUser(tenantId, token) : undefined;
  if (!tenantId || !user) {
    res.status(401).json({ success: false, message: 'Missing or invalid access token' });
    return;
  }
  res.locals.tenantId = tenantId;
  res.locals.user = user;
  next();
};

app.post('/api/auth/ws-ticket', authRateLimit, requireAccessToken, (req, res) => {
  const ticket = crypto.randomBytes(32).toString('hex');
  wsTickets.set(ticket, { tenantId: res.locals.tenantId, user: res.locals.user, expiresAt: Date.now() + 60_000 });
  res.json({ success: true, data: { ticket } });
});

const ticketCleanup = setInterval(() => {
  const now = Date.now();
  for (const [ticket, entry] of wsTickets) {
    if (entry.expiresAt <= now) wsTickets.delete(ticket);
  }
}, 60_000);
ticketCleanup.unref();

const tunnelHeartbeat = setInterval(() => {
  const now = Date.now();
  for (const tunnel of registry.list()) {
    if (now - tunnel.lastSeen > 90_000 || tunnel.socket.readyState !== WebSocket.OPEN) {
      registry.unregister(tunnel.tenantId);
      tunnel.socket.terminate();
      continue;
    }
    sendEnvelope(tunnel.socket, { type: 'ping', tenantId: tunnel.tenantId, ts: now });
  }
}, 30_000);
tunnelHeartbeat.unref();

function consumeWsTicket(tenantId: string, ticket: string): string | undefined {
  const entry = wsTickets.get(ticket);
  wsTickets.delete(ticket);
  if (!entry || entry.tenantId !== tenantId || entry.expiresAt <= Date.now()) return undefined;
  return entry.user;
}

function assertConfiguredRelayRuntime(): void {
  if (!config.databaseUrl || !config.port || !config.host) {
    throw new Error('Relay runtime is not configured: DATABASE_URL, PORT, and HOST must be set');
  }
}

async function proxyToTenant(req: express.Request, res: express.Response): Promise<void> {
  const tenantId = String(res.locals.tenantId || req.query.tenant_id || req.header('x-tenant-id') || '');
  const tunnel = registry.get(tenantId);
  if (!tunnel) {
    res.status(503).json({ success: false, message: 'No active tunnel for tenant' });
    return;
  }

  const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const headers: Record<string, string> = Object.fromEntries(
    Object.entries(req.headers)
      .flatMap(([name, value]) => {
        if (Array.isArray(value)) {
          const joined = value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0).join(',');
          return joined ? [[name, joined]] : [];
        }
        if (typeof value === 'string' && value.length > 0) {
          return [[name, value]];
        }
        return [];
      })
  );

  const safeQuery = Object.fromEntries(
    Object.entries(req.query).filter(([key]) => key !== 'user')
  ) as Record<string, string | string[]>;

  const proxyRequest: ProxyRequest = {
    method: (req.method as ProxyRequest['method']) || 'GET',
    path: req.path,
    headers,
    query: safeQuery,
    body: req.body,
    user: res.locals.user,
    userSignature: signRelayUser(tunnel.tunnelToken, tenantId, requestId, res.locals.user),
  };

  const envelope: RelayEnvelope<ProxyRequest> = {
    type: 'proxy_request',
    tenantId,
    requestId,
    payload: proxyRequest,
    ts: Date.now(),
  };

  const responsePromise = new Promise<ProxyResponse>((resolve, reject) => {
    const socket = tunnel.socket;
    const listener = (message: unknown) => {
      try {
        const text = messageText(message);
        if (!text) return;
        const obj = JSON.parse(text);
        if (!isJsonEnvelope(obj)) return;
        if (obj.type === 'proxy_response' && obj.requestId === requestId) {
          socket.off('message', listener);
          resolve((obj.payload as ProxyResponse) || { status: 200, body: {} });
          return;
        }
        if (obj.type === 'error' && obj.requestId === requestId) {
          socket.off('message', listener);
          reject(new Error(obj.error || 'Proxy failed'));
        }
      } catch {
        // ignore invalid messages
      }
    };

    socket.on('message', listener);
    sendEnvelope(socket, envelope);

    setTimeout(() => {
      socket.off('message', listener);
      reject(new Error('Proxy request timeout'));
    }, 30000);
  });

  try {
    const payload = await responsePromise;
    if (payload.headers) {
      for (const [name, value] of Object.entries(payload.headers)) {
        res.setHeader(name, value);
      }
    }
    if (typeof payload.text === 'string') {
      res.status(payload.status || 200).send(payload.text);
      return;
    }
    res.status(payload.status || 200).json(payload.body ?? payload.data ?? {});
  } catch (error) {
    const err = error as Error;
    res.status(502).json({ success: false, message: err.message || 'Proxy error' });
  }
}

app.get('/health', async (_req, res) => {
  try {
    await tenantStore.ready();
    res.json({ ok: true });
  } catch {
    res.status(503).json({ ok: false });
  }
});

app.post('/api/auth/register', authRateLimit, async (req, res) => {
  const { email, password, label } = req.body ?? {};
  if (typeof email !== 'string' || typeof password !== 'string') {
    res.status(400).json({ success: false, message: 'email and password are required' });
    return;
  }

  try {
    const tenant = await tenantStore.registerUser(email, password, typeof label === 'string' ? label : undefined);
    res.status(201).json({
      success: true,
      data: {
        user: email.trim().toLowerCase(),
        token: tenant.accessToken,
        tenantId: tenant.tenantId,
        tunnelToken: tenant.tunnelToken,
        label: tenant.label,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Registration failed';
    res.status(400).json({ success: false, message });
  }
});

app.post('/api/auth/login', authRateLimit, async (req, res) => {
  const { email, password, tenant_id: requestedTenantId } = req.body ?? {};
  if (typeof email !== 'string' || typeof password !== 'string') {
    res.status(400).json({ success: false, message: 'email and password are required' });
    return;
  }

  try {
    const tenants = await tenantStore.login(email, password);
    const tenant = typeof requestedTenantId === 'string'
      ? tenants.find((candidate) => candidate.tenantId === requestedTenantId)
      : tenants[0];
    if (requestedTenantId && !tenant) {
      res.status(404).json({ success: false, message: 'Tenant not found for this account' });
      return;
    }
    res.json({
      success: true,
      data: {
        user: email.trim().toLowerCase(),
        ...(tenant ? {
          token: tenant.accessToken,
          tenantId: tenant.tenantId,
          label: tenant.label,
        } : {}),
        tenants: tenants.map(({ tenantId, label }) => ({ tenantId, label })),
      },
    });
  } catch {
    res.status(401).json({ success: false, message: 'Invalid email or password' });
  }
});

app.get('/api/search', requireAccessToken, proxyToTenant);
app.post('/api/search', requireAccessToken, proxyToTenant);
app.get('/api/files/:path(*)', requireAccessToken, proxyToTenant);
app.post('/api/files/:path(*)', requireAccessToken, proxyToTenant);
app.delete('/api/files/:path(*)', requireAccessToken, proxyToTenant);
app.put('/api/files/:path(*)', requireAccessToken, proxyToTenant);
app.patch('/api/files/:path(*)', requireAccessToken, proxyToTenant);
app.get('/api/config', requireAccessToken, proxyToTenant);
app.post('/api/config', requireAccessToken, proxyToTenant);
app.get('/api/storage', requireAccessToken, proxyToTenant);
app.get('/api/shares', requireAccessToken, proxyToTenant);
app.post('/api/shares/share', requireAccessToken, proxyToTenant);
app.post('/api/shares/unshare', requireAccessToken, proxyToTenant);
app.get('/api/shares/list', requireAccessToken, proxyToTenant);

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: config.wsPath });

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(rateLimitCleanup);
  clearInterval(ticketCleanup);
  clearInterval(tunnelHeartbeat);
  for (const client of wss.clients) client.close(1001, 'Server shutting down');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await tenantStore.close();
};
process.once('SIGTERM', () => { void shutdown().finally(() => process.exit(0)); });
process.once('SIGINT', () => { void shutdown().finally(() => process.exit(0)); });


wss.on('connection', async (socket, request) => {
  const authHeader = request.headers.authorization || request.headers['x-tenant-token'];
  const url = new URL(request.url || '/', 'http://localhost');
  const tenantId = url.searchParams.get('tenant_id') || request.headers['x-tenant-id'] as string | undefined;
  const tunnelToken = url.searchParams.get('tenant_token') || (typeof request.headers['x-tenant-token'] === 'string' ? request.headers['x-tenant-token'] : undefined);
  const accessToken = typeof authHeader === 'string' ? authHeader.replace(/^Bearer\s+/i, '') : undefined;
  const wsTicket = url.searchParams.get('ws_ticket');

  if (!tenantId || (!tunnelToken && !accessToken)) {
    socket.close(1008, 'Unauthorized');
    return;
  }

  const isTunnel = Boolean(tunnelToken && await tenantStore.verifyToken(tenantId, tunnelToken));
  const clientUser = (wsTicket && consumeWsTicket(tenantId, wsTicket))
    || (accessToken ? await tenantStore.getAccessTokenUser(tenantId, accessToken) : undefined);
  const isClient = Boolean(clientUser);
  if (!isTunnel && !isClient) {
    socket.close(1008, 'Invalid tenant credentials');
    return;
  }

  try {
    if (isTunnel) {
      registry.register(tenantId, socket, tunnelToken!);
      sendEnvelope(socket, { type: 'hello', tenantId, ts: Date.now() });
    }

    socket.on('message', (raw) => {
      try {
        if (isTunnel) registry.touch(tenantId, socket);
        const message = raw.toString();
        const parsed = JSON.parse(message) as RelayEnvelope;
        if (!isJsonEnvelope(parsed)) return;
        if (parsed.type === 'proxy_response') {
          socket.send(message);
          return;
        }
        if (parsed.type === 'proxy_request') {
          const proxyRequest = parseProxyRequest(parsed.payload);
          if (!proxyRequest) {
            sendEnvelope(socket, { type: 'error', requestId: parsed.requestId, tenantId, error: 'Malformed proxy request', ts: Date.now() });
            return;
          }

          const tunnel = registry.get(tenantId);
          if (!tunnel || tunnel.socket === socket) {
            sendEnvelope(socket, { type: 'error', requestId: parsed.requestId, tenantId, error: 'No active tunnel for tenant', ts: Date.now() });
            return;
          }

          const requestId = parsed.requestId || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
          const relayRequest: RelayEnvelope<ProxyRequest> = {
            type: 'proxy_request',
            tenantId,
            requestId,
              payload: {
                ...proxyRequest,
                user: clientUser,
                userSignature: signRelayUser(tunnel.tunnelToken, tenantId, requestId, clientUser!),
              },
            ts: Date.now(),
          };

          const responseListener = (message: unknown) => {
            try {
              const text = messageText(message);
              if (!text) return;
              const obj = JSON.parse(text);
              if (!isJsonEnvelope(obj)) return;
              if (obj.type === 'proxy_response' && obj.requestId === requestId) {
                tunnel.socket.off('message', responseListener);
                socket.send(text);
                return;
              }
              if (obj.type === 'error' && obj.requestId === requestId) {
                tunnel.socket.off('message', responseListener);
                socket.send(text);
              }
            } catch {
              // ignore malformed relay traffic
            }
          };

          tunnel.socket.on('message', responseListener);
          sendEnvelope(tunnel.socket, relayRequest);

          setTimeout(() => {
            tunnel.socket.off('message', responseListener);
            sendEnvelope(socket, { type: 'error', requestId, tenantId, error: 'Proxy request timeout', ts: Date.now() });
          }, 30000);
        }
      } catch (error) {
        sendEnvelope(socket, { type: 'error', tenantId, error: error instanceof Error ? error.message : 'Unknown error', ts: Date.now() });
      }
    });

    socket.on('close', () => {
      if (isTunnel) registry.unregister(tenantId);
    });

    socket.on('error', () => {
      if (isTunnel) registry.unregister(tenantId);
    });

    console.log(`Tenant ${tenantId} connected via WebSocket ${isTunnel ? 'tunnel' : 'client'}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown connection error';
    socket.close(1008, message);
  }

});

try {
  assertConfiguredRelayRuntime();
  tenantStore.init()
    .then(() => {
      server.listen(config.port, config.host, () => {
        console.log(`Flux Cloud Relay listening on http://${config.host}:${config.port}${config.wsPath}`);
      });
    })
    .catch((error) => {
      console.error('Failed to initialize tenant store', error);
      process.exit(1);
    });
} catch (error) {
  console.error('Relay startup configuration failed:', error instanceof Error ? error.message : error);
  process.exit(1);
}
