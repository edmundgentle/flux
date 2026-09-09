export function uuid() {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
        const random = Math.random() * 16 | 0;
        const value = char === 'x' ? random : (random & 0x3) | 0x8;
        return value.toString(16);
    });
}
export function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
export function normalizeUrl(base) {
    return base.endsWith('/') ? base.slice(0, -1) : base;
}
export function buildRelaySocketUrl(base, instanceId, ticket) {
    const url = new URL(base);
    if (url.protocol === 'http:')
        url.protocol = 'ws:';
    if (url.protocol === 'https:')
        url.protocol = 'wss:';
    if (url.pathname === '' || url.pathname === '/') {
        url.pathname = '/ws';
    }
    else if (!url.pathname.endsWith('/ws')) {
        url.pathname = `${url.pathname.replace(/\/$/, '')}/ws`;
    }
    url.searchParams.set('instance_id', instanceId);
    url.searchParams.set('ws_ticket', ticket);
    return url.toString();
}
export function safeJsonParse(input) {
    try {
        return JSON.parse(input);
    }
    catch {
        return undefined;
    }
}
export function getMimeType(fileName) {
    const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
    switch (ext) {
        case 'jpg':
        case 'jpeg':
            return 'image/jpeg';
        case 'png':
            return 'image/png';
        case 'webp':
            return 'image/webp';
        case 'gif':
            return 'image/gif';
        case 'pdf':
            return 'application/pdf';
        case 'txt':
            return 'text/plain';
        case 'json':
            return 'application/json';
        default:
            return 'application/octet-stream';
    }
}
