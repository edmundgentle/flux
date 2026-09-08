export declare function uuid(): string;
export declare function sleep(ms: number): Promise<void>;
export declare function normalizeUrl(base: string): string;
export declare function buildRelaySocketUrl(base: string, tenantId: string, ticket: string): string;
export declare function safeJsonParse<T>(input: string): T | undefined;
export declare function getMimeType(fileName: string): string;
