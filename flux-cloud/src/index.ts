import express from 'express';
import crypto from 'node:crypto';
import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { loadConfig } from './config';
import { TunnelRegistry, SharedRelay, sendEnvelope, isJsonEnvelope, parseProxyRequest, makeProxyResponse } from './relay';
import { ProxyRequest, RelayEnvelope, ProxyResponse } from './types';
import { UserStore } from './users';

const config = loadConfig();
const registry = new TunnelRegistry();
const userStore = new UserStore(config.databaseUrl);
const app = express();
app.set('trust proxy', process.env.TRUST_PROXY === 'true');
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
const provisionRateLimit = rateLimit(60_000, 5);
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

function signRelayUser(tunnelToken: string, instanceId: string, requestId: string, user: string): string {
  return crypto.createHmac('sha256', tunnelToken)
    .update(`${instanceId}\n${requestId}\n${user}`)
    .digest('hex');
}

const relay = new SharedRelay(config.redisUrl, registry, signRelayUser);

app.use((req, res, next) => {
  const origin = req.header('origin');
  if (origin && (config.corsOrigins.includes('*') || config.corsOrigins.includes(origin))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Instance-Id');
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
  const instanceId = typeof req.query.instance_id === 'string' ? req.query.instance_id : req.header('x-instance-id');
  const authorization = req.header('authorization');
  const token = authorization?.replace(/^Bearer\s+/i, '');
  const user = instanceId && token ? await userStore.getAccessTokenUser(instanceId, token) : undefined;
  if (!instanceId || !user) {
    res.status(401).json({ success: false, message: 'Missing or invalid access token' });
    return;
  }
  res.locals.instanceId = instanceId;
  res.locals.user = user;
  next();
};

// Authenticates the instance itself (e.g. the Home Assistant add-on) using its tunnel token,
// for endpoints that manage the instance rather than acting as one of its users.
const requireInstanceToken = async (req: express.Request, res: express.Response, next: express.NextFunction): Promise<void> => {
  const instanceId = String(req.params.instanceId || '');
  const authorization = req.header('authorization');
  const token = authorization?.replace(/^Bearer\s+/i, '');
  if (!instanceId || !token || !(await userStore.verifyToken(instanceId, token))) {
    res.status(401).json({ success: false, message: 'Missing or invalid instance token' });
    return;
  }
  next();
};

app.post('/api/auth/ws-ticket', authRateLimit, requireAccessToken, async (req, res) => {
  const ticket = crypto.randomBytes(32).toString('hex');
  try {
    await relay.createWsTicket(ticket, res.locals.instanceId, res.locals.user);
    res.json({ success: true, data: { ticket } });
  } catch {
    res.status(503).json({ success: false, message: 'Relay coordination unavailable' });
  }
});

// The relay signs the authenticated cloud user before forwarding this to the instance.
// The local token never becomes a cloud credential and is only used for LAN requests.
app.post('/api/auth/local-session', authRateLimit, requireAccessToken, proxyToInstance);

const tunnelHeartbeat = setInterval(() => {
  void relay.renewTunnels();
  const now = Date.now();
  for (const tunnel of registry.list()) {
    if (now - tunnel.lastSeen > 90_000 || tunnel.socket.readyState !== WebSocket.OPEN) {
      registry.unregister(tunnel.instanceId);
      tunnel.socket.terminate();
      continue;
    }
    sendEnvelope(tunnel.socket, { type: 'ping', instanceId: tunnel.instanceId, ts: now });
  }
}, 30_000);
tunnelHeartbeat.unref();

function assertConfiguredRelayRuntime(): void {
  if (!config.databaseUrl || !config.redisUrl || !config.port || !config.host) {
    throw new Error('Relay runtime is not configured: DATABASE_URL, REDIS_URL, PORT, and HOST must be set');
  }
}

async function proxyToInstance(req: express.Request, res: express.Response): Promise<void> {
  const instanceId = String(res.locals.instanceId || req.query.instance_id || req.header('x-instance-id') || '');
  const requestId = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
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
  };

  try {
    const payload = await relay.request(instanceId, requestId, proxyRequest, res.locals.user);
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
    await userStore.ready();
    res.json({ ok: true });
  } catch {
    res.status(503).json({ ok: false });
  }
});

app.post('/api/instances/provision', provisionRateLimit, async (req, res) => {
  const { label } = req.body ?? {};
  try {
    const instance = await userStore.provisionInstance(typeof label === 'string' ? label : undefined);
    res.status(201).json({
      success: true,
      data: {
        instanceId: instance.instanceId,
        tunnelToken: instance.tunnelToken,
        label: instance.label,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Provisioning failed';
    res.status(400).json({ success: false, message });
  }
});

app.get('/api/instances/:instanceId', requireInstanceToken, async (req, res) => {
  const instanceId = String(req.params.instanceId);
  try {
    const label = await userStore.getInstanceLabel(instanceId);
    if (!label) {
      res.status(404).json({ success: false, message: 'Instance not found' });
      return;
    }
    const members = await userStore.listMembers(instanceId);
    res.json({ success: true, data: { instanceId, label, members } });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load instance';
    res.status(400).json({ success: false, message });
  }
});

app.put('/api/instances/:instanceId/label', authRateLimit, requireInstanceToken, async (req, res) => {
  const { label } = req.body ?? {};
  if (typeof label !== 'string') {
    res.status(400).json({ success: false, message: 'label is required' });
    return;
  }
  try {
    const savedLabel = await userStore.renameInstance(String(req.params.instanceId), label);
    res.json({ success: true, data: { label: savedLabel } });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to rename instance';
    res.status(400).json({ success: false, message });
  }
});

app.post('/api/instances/:instanceId/members', authRateLimit, requireInstanceToken, async (req, res) => {
  const { email } = req.body ?? {};
  if (typeof email !== 'string') {
    res.status(400).json({ success: false, message: 'email is required' });
    return;
  }
  try {
    const outcome = await userStore.inviteOrAssignMember(String(req.params.instanceId), email);
    res.status(outcome.status === 'invited' ? 201 : 200).json({ success: true, data: outcome });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to add member';
    res.status(400).json({ success: false, message });
  }
});

app.post('/api/auth/register', authRateLimit, async (req, res) => {
  const email = typeof req.body?.email === 'string' ? req.body.email : (typeof req.body?.username === 'string' ? req.body.username : undefined);
  const password = req.body?.password;
  const label = req.body?.label;
  if (typeof email !== 'string' || typeof password !== 'string') {
    res.status(400).json({ success: false, message: 'email and password are required' });
    return;
  }

  try {
    const instance = await userStore.registerUser(email, password, typeof label === 'string' ? label : undefined);
    res.status(201).json({
      success: true,
      data: {
        user: email.trim().toLowerCase(),
        token: instance.accessToken,
        instanceId: instance.instanceId,
        tunnelToken: instance.tunnelToken,
        label: instance.label,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Registration failed';
    res.status(400).json({ success: false, message });
  }
});

app.post('/api/auth/login', authRateLimit, async (req, res) => {
  const email = typeof req.body?.email === 'string' ? req.body.email : (typeof req.body?.username === 'string' ? req.body.username : undefined);
  const password = req.body?.password;
  const requestedInstanceId = req.body?.instance_id;
  if (typeof email !== 'string' || typeof password !== 'string') {
    res.status(400).json({ success: false, message: 'email and password are required' });
    return;
  }

  try {
    const instances = await userStore.login(email, password);
    const instance = typeof requestedInstanceId === 'string'
      ? instances.find((candidate) => candidate.instanceId === requestedInstanceId)
      : instances[0];
    if (requestedInstanceId && !instance) {
      res.status(404).json({ success: false, message: 'Instance not found for this account' });
      return;
    }
    if (!instance) {
      res.status(404).json({ success: false, message: 'No instance found for this account' });
      return;
    }
    res.json({
      success: true,
      data: {
        user: email.trim().toLowerCase(),
        token: instance.accessToken,
        instanceId: instance.instanceId,
        label: instance.label,
        instances: instances.map(({ instanceId, label }) => ({ instanceId, label })),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid email or password';
    res.status(401).json({ success: false, message });
  }
});

app.get('/api/search', requireAccessToken, proxyToInstance);
app.post('/api/search', requireAccessToken, proxyToInstance);
app.get('/api/files/:path(*)', requireAccessToken, proxyToInstance);
app.post('/api/files/:path(*)', requireAccessToken, proxyToInstance);
app.delete('/api/files/:path(*)', requireAccessToken, proxyToInstance);
app.put('/api/files/:path(*)', requireAccessToken, proxyToInstance);
app.patch('/api/files/:path(*)', requireAccessToken, proxyToInstance);
app.get('/api/config', requireAccessToken, proxyToInstance);
app.post('/api/config', requireAccessToken, proxyToInstance);
app.get('/api/storage', requireAccessToken, proxyToInstance);
app.get('/api/shares', requireAccessToken, proxyToInstance);
app.post('/api/shares/share', requireAccessToken, proxyToInstance);
app.post('/api/shares/unshare', requireAccessToken, proxyToInstance);
app.get('/api/shares/list', requireAccessToken, proxyToInstance);

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: config.wsPath });

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(rateLimitCleanup);
  clearInterval(tunnelHeartbeat);
  for (const client of wss.clients) client.close(1001, 'Server shutting down');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await relay.close();
  await userStore.close();
};
process.once('SIGTERM', () => { void shutdown().finally(() => process.exit(0)); });
process.once('SIGINT', () => { void shutdown().finally(() => process.exit(0)); });


wss.on('connection', async (socket, request) => {
  const authHeader = request.headers.authorization || request.headers['x-instance-token'];
  const url = new URL(request.url || '/', 'http://localhost');
  const instanceId = url.searchParams.get('instance_id') || request.headers['x-instance-id'] as string | undefined;
  const tunnelToken = url.searchParams.get('instance_token') || (typeof request.headers['x-instance-token'] === 'string' ? request.headers['x-instance-token'] : undefined);
  const accessToken = typeof authHeader === 'string' ? authHeader.replace(/^Bearer\s+/i, '') : undefined;
  const wsTicket = url.searchParams.get('ws_ticket');

  if (!instanceId || (!tunnelToken && !accessToken && !wsTicket)) {
    socket.close(1008, 'Unauthorized');
    return;
  }

  const isTunnel = Boolean(tunnelToken && await userStore.verifyToken(instanceId, tunnelToken));
  const clientUser = (wsTicket && await relay.consumeWsTicket(instanceId, wsTicket))
    || (accessToken ? await userStore.getAccessTokenUser(instanceId, accessToken) : undefined);
  const isClient = Boolean(clientUser);
  if (!isTunnel && !isClient) {
    socket.close(1008, 'Invalid instance credentials');
    return;
  }

  try {
    if (isTunnel) {
      registry.register(instanceId, socket, tunnelToken!);
      await relay.claimTunnel(instanceId);
      sendEnvelope(socket, { type: 'hello', instanceId, ts: Date.now() });
    }

    // The HA bridge now sends WebSocket-protocol ping frames as an additional keepalive
    // (on top of the JSON "ping"/"pong" envelopes below); 'ws' auto-replies with pong,
    // but count the incoming ping itself as activity too so NAT/proxy hops stay warm.
    socket.on('ping', () => {
      if (isTunnel) registry.touch(instanceId, socket);
    });

    socket.on('message', (raw) => {
      try {
        if (isTunnel) registry.touch(instanceId, socket);
        const message = raw.toString();
        const parsed = JSON.parse(message) as RelayEnvelope;
        if (!isJsonEnvelope(parsed)) return;
        if (parsed.type === 'proxy_response') {
          return;
        }
        if (parsed.type === 'proxy_request') {
          const proxyRequest = parseProxyRequest(parsed.payload);
          if (!proxyRequest) {
            sendEnvelope(socket, { type: 'error', requestId: parsed.requestId, instanceId, error: 'Malformed proxy request', ts: Date.now() });
            return;
          }

          const requestId = parsed.requestId || `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
          void relay.request(instanceId, requestId, proxyRequest, clientUser!)
            .then((payload) => sendEnvelope(socket, makeProxyResponse(payload, requestId, instanceId)))
            .catch((error) => sendEnvelope(socket, {
              type: 'error',
              requestId,
              instanceId,
              error: error instanceof Error ? error.message : 'Proxy failed',
              ts: Date.now(),
            }));
        }
      } catch (error) {
        sendEnvelope(socket, { type: 'error', instanceId, error: error instanceof Error ? error.message : 'Unknown error', ts: Date.now() });
      }
    });

    socket.on('close', (code, reason) => {
      console.warn(`Instance ${instanceId} WebSocket closed ${isTunnel ? 'tunnel' : 'client'} code=${code} reason=${reason.toString() || 'none'}`);
      if (isTunnel && registry.get(instanceId)?.socket === socket) {
        registry.unregister(instanceId);
        void relay.releaseTunnel(instanceId);
      }
    });

    socket.on('error', (error) => {
      console.error(`Instance ${instanceId} WebSocket error ${isTunnel ? 'tunnel' : 'client'}`, error);
      if (isTunnel && registry.get(instanceId)?.socket === socket) {
        registry.unregister(instanceId);
        void relay.releaseTunnel(instanceId);
      }
    });

    console.log(`Instance ${instanceId} connected via WebSocket ${isTunnel ? 'tunnel' : 'client'}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown connection error';
    socket.close(1008, message);
  }

});

try {
  assertConfiguredRelayRuntime();
  Promise.all([userStore.init(), relay.start()])
    .then(() => {
      server.listen(config.port, config.host, () => {
        console.log(`Flux Cloud Relay listening on http://${config.host}:${config.port}${config.wsPath}`);
      });
    })
    .catch((error) => {
      console.error('Failed to initialize instance store', error);
      process.exit(1);
    });
} catch (error) {
  console.error('Relay startup configuration failed:', error instanceof Error ? error.message : error);
  process.exit(1);
}
