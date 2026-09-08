import { buildRelaySocketUrl, getMimeType, sleep, uuid, safeJsonParse } from './utils.js';
function encodeBase64(bytes) {
    let binary = '';
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
    }
    return btoa(binary);
}
function decodeBase64(value) {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
}
export class FluxClient {
    config;
    socket = null;
    pending = new Map();
    reconnectDelay = 1000;
    state = 'disconnected';
    listeners = [];
    fetchImpl;
    authSession = null;
    reconnectEnabled = true;
    constructor(config) {
        this.config = config;
        this.fetchImpl = config.fetchImpl ?? fetch.bind(globalThis);
        if (config.autoConnect !== false)
            void this.connect();
    }
    onStateChange(listener) {
        this.listeners.push(listener);
        return () => { this.listeners = this.listeners.filter((item) => item !== listener); };
    }
    getState() { return this.state; }
    getAuthSession() { return this.authSession; }
    async register(credentials) {
        return await this.authenticate('/api/auth/register', { email: credentials.username.trim(), password: credentials.password, label: credentials.displayName?.trim() || undefined }, 'register');
    }
    async login(credentials) {
        return await this.authenticate('/api/auth/login', { email: credentials.username.trim(), password: credentials.password, tenant_id: credentials.tenantId }, 'login');
    }
    logout() {
        this.reconnectEnabled = false;
        this.authSession = null;
        this.config.accessToken = undefined;
        for (const pending of this.pending.values())
            pending.reject(new Error('Signed out'));
        this.pending.clear();
        if (this.socket) {
            this.socket.close(1000, 'Signed out');
            this.socket = null;
        }
        this.setState('disconnected');
    }
    async authenticate(path, body, action) {
        const response = await this.fetchImpl(new URL(path, this.config.relayUrl), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const payload = await response.json();
        const session = payload.data;
        if (!response.ok || !session?.token || !session.tenantId)
            throw new Error(payload.message || `${action} failed`);
        this.config.tenantId = session.tenantId;
        this.config.accessToken = session.token;
        this.authSession = session;
        return session;
    }
    async connect() {
        this.reconnectEnabled = true;
        if (this.socket?.readyState === 1)
            return;
        const relayUrl = this.config.relayUrl?.trim();
        const tenantId = this.config.tenantId?.trim();
        if (!relayUrl || !tenantId) {
            throw new Error('Relay URL and tenant ID are required before connecting');
        }
        const accessToken = this.authSession?.token || this.config.accessToken;
        if (!accessToken)
            throw new Error('Sign in before connecting to the relay');
        this.setState('connecting');
        const ticketResponse = await this.fetchImpl(new URL('/api/auth/ws-ticket', relayUrl), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${accessToken}`,
                'x-tenant-id': this.config.tenantId,
            },
        });
        const ticketPayload = await ticketResponse.json();
        const ticket = ticketPayload.data?.ticket;
        if (!ticketResponse.ok || !ticket)
            throw new Error(ticketPayload.message || 'Unable to establish relay session');
        const SocketCtor = this.config.websocketCtor ?? WebSocket;
        const socket = new SocketCtor(buildRelaySocketUrl(this.config.relayUrl, this.config.tenantId, ticket));
        this.socket = socket;
        socket.onopen = () => { this.reconnectDelay = 1000; this.setState('connected'); };
        socket.onmessage = (event) => {
            const parsed = safeJsonParse(typeof event.data === 'string' ? event.data : '');
            if (!parsed?.requestId)
                return;
            const pending = this.pending.get(parsed.requestId);
            if (!pending)
                return;
            this.pending.delete(parsed.requestId);
            if (parsed.type === 'error')
                pending.reject(new Error(parsed.error ?? 'Relay request failed'));
            else
                pending.resolve(parsed.payload ?? {});
        };
        socket.onerror = () => this.setState('reconnecting');
        socket.onclose = () => {
            this.socket = null;
            if (this.reconnectEnabled) {
                this.setState('reconnecting');
                void this.retryConnect();
            }
            else {
                this.setState('disconnected');
            }
        };
    }
    async retryConnect() {
        if (!this.reconnectEnabled || this.state === 'connecting')
            return;
        await sleep(this.reconnectDelay);
        if (!this.reconnectEnabled)
            return;
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
        try {
            await this.connect();
        }
        catch {
            if (this.reconnectEnabled)
                void this.retryConnect();
        }
    }
    setState(next) {
        if (this.state === next)
            return;
        this.state = next;
        for (const listener of this.listeners)
            listener(next);
    }
    async sendRelayRequest(payload) {
        await this.connect();
        if (!this.socket || this.socket.readyState !== 1)
            throw new Error('Relay socket is not connected');
        const requestId = uuid();
        const request = { type: 'proxy_request', tenantId: this.config.tenantId, requestId, payload, ts: Date.now() };
        return await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => { this.pending.delete(requestId); reject(new Error('Relay request timed out')); }, 30000);
            this.pending.set(requestId, { resolve: (value) => { clearTimeout(timeout); resolve(value); }, reject: (error) => { clearTimeout(timeout); reject(error); } });
            this.socket.send(JSON.stringify(request));
        });
    }
    async httpRequest(path, method, body) {
        const useLan = Boolean(this.config.localBaseUrl && this.config.localUseLan);
        const base = useLan ? this.config.localBaseUrl : this.config.relayUrl;
        const token = useLan ? this.config.localAccessToken : (this.authSession?.token || this.config.accessToken);
        const response = await this.fetchImpl(new URL(path, base), { method, headers: { 'Content-Type': 'application/json', ...(useLan ? {} : { 'x-tenant-id': this.config.tenantId }), Authorization: `Bearer ${token || ''}` }, body: body === undefined ? undefined : JSON.stringify(body) });
        const text = await response.text();
        if (!response.ok)
            throw new Error(text || `Request failed: ${response.status}`);
        return text ? JSON.parse(text) : undefined;
    }
    async search(params) {
        if (this.config.localUseLan && this.config.localBaseUrl) {
            const url = new URL('/api/search', this.config.localBaseUrl);
            url.searchParams.set('q', params.q);
            url.searchParams.set('limit', String(params.limit ?? 20));
            const response = await this.fetchImpl(url, {
                headers: { Authorization: `Bearer ${this.config.localAccessToken || ''}` },
            });
            if (!response.ok)
                throw new Error(`Search failed: ${response.status}`);
            return await response.json();
        }
        const payload = await this.sendRelayRequest({ method: 'GET', path: '/api/search', query: { q: params.q, limit: String(params.limit ?? 20) }, headers: { Authorization: `Bearer ${this.authSession?.token || this.config.accessToken || ''}` } });
        if (!payload || payload.status >= 400)
            throw new Error('Search failed');
        return (payload.body ?? payload.data ?? []);
    }
    async uploadFile(file, options = {}) {
        const fileName = options.path || `upload-${Date.now()}.bin`;
        const uploadPath = options.directory
            ? `${options.directory.replace(/\/+$/, '')}/${fileName.replace(/^\/+/, '')}`
            : fileName;
        const arrayBuffer = await (file instanceof Blob
            ? file.arrayBuffer()
            : Promise.resolve(file instanceof Uint8Array
                ? file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength)
                : file));
        const bytes = new Uint8Array(arrayBuffer);
        if (this.config.localUseLan && this.config.localBaseUrl) {
            const url = new URL('/api/files/upload', this.config.localBaseUrl);
            url.searchParams.set('path', uploadPath);
            const form = new FormData();
            form.append('file', new Blob([bytes.buffer], { type: getMimeType(fileName) }), fileName);
            const response = await this.fetchImpl(url, {
                method: 'POST',
                headers: { Authorization: `Bearer ${this.config.localAccessToken || ''}` },
                body: form,
            });
            const payload = await response.json();
            if (!response.ok)
                throw new Error(payload.message || `Upload failed: ${response.status}`);
            return { path: payload.data || uploadPath };
        }
        const payload = await this.sendRelayRequest({ method: 'POST', path: '/api/files/upload', query: { path: uploadPath }, headers: { Authorization: `Bearer ${this.authSession?.token || this.config.accessToken || ''}` }, body: { file_name: fileName, content_b64: encodeBase64(bytes) } });
        if (!payload || payload.status >= 400)
            throw new Error('Upload failed');
        return (payload.body ?? payload.data ?? { path: uploadPath });
    }
    async downloadFile(path, options = {}) {
        const useLan = Boolean(this.config.localBaseUrl && this.config.localUseLan);
        const base = useLan ? this.config.localBaseUrl : this.config.relayUrl;
        const token = useLan ? this.config.localAccessToken : (this.authSession?.token || this.config.accessToken);
        const url = new URL('/api/files/download', base);
        if (!useLan)
            url.searchParams.set('tenant_id', this.config.tenantId);
        url.searchParams.set('path', path);
        if (options.user)
            url.searchParams.set('user', options.user);
        const response = await this.fetchImpl(url, { headers: { Authorization: `Bearer ${token || ''}` } });
        if (!response.ok)
            throw new Error(`Download failed: ${response.status}`);
        if (!response.headers.get('content-type')?.includes('application/json'))
            return await response.blob();
        const payload = await response.json();
        if (!payload.content_b64)
            throw new Error('Download response did not include file content');
        const bytes = decodeBase64(payload.content_b64);
        return new Blob([bytes.buffer], { type: payload.mime_type || 'application/octet-stream' });
    }
    async getConfig() { return await this.httpRequest('/api/config', 'GET'); }
    async disconnect() {
        this.reconnectEnabled = false;
        if (this.socket) {
            this.socket.close();
            this.socket = null;
        }
        this.setState('disconnected');
    }
}
