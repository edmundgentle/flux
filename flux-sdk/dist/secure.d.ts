export declare const KEY_ID_HEADER = "x-flux-key-id";
export type SecureRequest = {
    method: string;
    path: string;
    query?: Record<string, string>;
    headers?: Record<string, string>;
    body?: Uint8Array;
};
export type SecureResponse = {
    status: number;
    headers: Record<string, string>;
    body: Uint8Array;
};
export declare class SecureChannel {
    readonly keyId: string;
    private readonly clientToServer;
    private readonly serverToClient;
    private readonly aad;
    constructor(token: string, keyId: string);
    /** A sequence number is used once per session, satisfying GCM's never-reuse-a-nonce rule. */
    private nonce;
    private encrypt;
    private decrypt;
    /** Seals a request as `seq || AES-GCM(len || header || body)`. */
    sealRequest(seq: number, request: SecureRequest): Promise<Uint8Array>;
    openResponse(seq: number, envelope: Uint8Array): Promise<SecureResponse>;
    /** Server half of the exchange. The instance implements this in Rust; used here for tests. */
    openRequest(envelope: Uint8Array): Promise<{
        seq: number;
        request: SecureRequest;
    }>;
    sealResponse(seq: number, response: SecureResponse): Promise<Uint8Array>;
}
/**
 * Builds a multipart body by hand so the exact bytes can be sealed. `FormData` does not expose
 * its generated boundary, which the inner content-type header has to match.
 */
export declare function buildMultipartBody(fieldName: string, fileName: string, mimeType: string, bytes: Uint8Array): {
    contentType: string;
    body: Uint8Array;
};
