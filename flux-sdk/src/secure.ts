import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { gcm } from '@noble/ciphers/aes.js';

/**
 * Encrypted request envelopes for the LAN transport.
 *
 * Requests to the local instance travel over plain HTTP, so the access token is never sent.
 * Both sides derive AES-256-GCM keys from it instead and exchange whole requests and responses
 * as sealed envelopes. The GCM tag authenticates the payload - no separate signature is needed -
 * and the per-request sequence number both forms the nonce and drives replay rejection.
 */

const INFO_CLIENT_TO_SERVER = 'flux-secure-v1-client-to-server';
const INFO_SERVER_TO_CLIENT = 'flux-secure-v1-server-to-client';

export const KEY_ID_HEADER = 'x-flux-key-id';

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

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** WebCrypto AES-GCM is hardware-backed where available; noble is the portable fallback. */
function subtleCrypto(): SubtleCrypto | undefined {
  const candidate = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
  return typeof candidate?.encrypt === 'function' ? candidate : undefined;
}

export class SecureChannel {
  private readonly clientToServer: Uint8Array;
  private readonly serverToClient: Uint8Array;
  private readonly aad: Uint8Array;

  constructor(token: string, public readonly keyId: string) {
    const secret = encoder.encode(token);
    const salt = encoder.encode(keyId);
    this.clientToServer = hkdf(sha256, secret, salt, encoder.encode(INFO_CLIENT_TO_SERVER), 32);
    this.serverToClient = hkdf(sha256, secret, salt, encoder.encode(INFO_SERVER_TO_CLIENT), 32);
    this.aad = salt;
  }

  /** A sequence number is used once per session, satisfying GCM's never-reuse-a-nonce rule. */
  private nonce(seq: number): Uint8Array {
    const nonce = new Uint8Array(12);
    new DataView(nonce.buffer).setBigUint64(4, BigInt(seq), false);
    return nonce;
  }

  private async encrypt(key: Uint8Array, seq: number, plaintext: Uint8Array): Promise<Uint8Array> {
    const nonce = this.nonce(seq);
    const subtle = subtleCrypto();
    if (!subtle) return gcm(key, nonce, this.aad).encrypt(plaintext);
    const imported = await subtle.importKey('raw', key as BufferSource, 'AES-GCM', false, ['encrypt']);
    const sealed = await subtle.encrypt(
      { name: 'AES-GCM', iv: nonce as BufferSource, additionalData: this.aad as BufferSource },
      imported,
      plaintext as BufferSource,
    );
    return new Uint8Array(sealed);
  }

  private async decrypt(key: Uint8Array, seq: number, ciphertext: Uint8Array): Promise<Uint8Array> {
    const nonce = this.nonce(seq);
    const subtle = subtleCrypto();
    if (!subtle) return gcm(key, nonce, this.aad).decrypt(ciphertext);
    const imported = await subtle.importKey('raw', key as BufferSource, 'AES-GCM', false, ['decrypt']);
    const opened = await subtle.decrypt(
      { name: 'AES-GCM', iv: nonce as BufferSource, additionalData: this.aad as BufferSource },
      imported,
      ciphertext as BufferSource,
    );
    return new Uint8Array(opened);
  }

  /** Seals a request as `seq || AES-GCM(len || header || body)`. */
  async sealRequest(seq: number, request: SecureRequest): Promise<Uint8Array> {
    const header = encoder.encode(JSON.stringify({
      method: request.method,
      path: request.path,
      query: request.query ?? {},
      headers: request.headers ?? {},
    }));
    const body = request.body ?? new Uint8Array(0);

    const plaintext = new Uint8Array(4 + header.length + body.length);
    new DataView(plaintext.buffer).setUint32(0, header.length, false);
    plaintext.set(header, 4);
    plaintext.set(body, 4 + header.length);

    const ciphertext = await this.encrypt(this.clientToServer, seq, plaintext);
    const envelope = new Uint8Array(8 + ciphertext.length);
    new DataView(envelope.buffer).setBigUint64(0, BigInt(seq), false);
    envelope.set(ciphertext, 8);
    return envelope;
  }

  async openResponse(seq: number, envelope: Uint8Array): Promise<SecureResponse> {
    const plaintext = await this.decrypt(this.serverToClient, seq, envelope);
    if (plaintext.length < 4) throw new Error('Envelope response is truncated');
    const headerLength = new DataView(plaintext.buffer, plaintext.byteOffset).getUint32(0, false);
    if (plaintext.length < 4 + headerLength) throw new Error('Envelope header length is out of range');

    const header = JSON.parse(decoder.decode(plaintext.subarray(4, 4 + headerLength))) as {
      status?: number;
      headers?: Record<string, string>;
    };
    return {
      status: header.status ?? 200,
      headers: header.headers ?? {},
      // Copied rather than a view, so callers can hand the buffer straight to Blob.
      body: plaintext.slice(4 + headerLength),
    };
  }

  /** Server half of the exchange. The instance implements this in Rust; used here for tests. */
  async openRequest(envelope: Uint8Array): Promise<{ seq: number; request: SecureRequest }> {
    if (envelope.length < 8) throw new Error('Envelope is too short to contain a sequence number');
    const seq = Number(new DataView(envelope.buffer, envelope.byteOffset).getBigUint64(0, false));
    const plaintext = await this.decrypt(this.clientToServer, seq, envelope.subarray(8));
    const headerLength = new DataView(plaintext.buffer, plaintext.byteOffset).getUint32(0, false);
    const header = JSON.parse(decoder.decode(plaintext.subarray(4, 4 + headerLength))) as SecureRequest;
    return { seq, request: { ...header, body: plaintext.slice(4 + headerLength) } };
  }

  async sealResponse(seq: number, response: SecureResponse): Promise<Uint8Array> {
    const header = encoder.encode(JSON.stringify({ status: response.status, headers: response.headers }));
    const plaintext = new Uint8Array(4 + header.length + response.body.length);
    new DataView(plaintext.buffer).setUint32(0, header.length, false);
    plaintext.set(header, 4);
    plaintext.set(response.body, 4 + header.length);
    return await this.encrypt(this.serverToClient, seq, plaintext);
  }
}

/**
 * Builds a multipart body by hand so the exact bytes can be sealed. `FormData` does not expose
 * its generated boundary, which the inner content-type header has to match.
 */
export function buildMultipartBody(fieldName: string, fileName: string, mimeType: string, bytes: Uint8Array): {
  contentType: string;
  body: Uint8Array;
} {
  const boundary = `----FluxBoundary${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
  const preamble = encoder.encode(
    `--${boundary}\r\n`
    + `Content-Disposition: form-data; name="${fieldName}"; filename="${fileName.replace(/"/g, '')}"\r\n`
    + `Content-Type: ${mimeType}\r\n\r\n`,
  );
  const epilogue = encoder.encode(`\r\n--${boundary}--\r\n`);

  const body = new Uint8Array(preamble.length + bytes.length + epilogue.length);
  body.set(preamble, 0);
  body.set(bytes, preamble.length);
  body.set(epilogue, preamble.length + bytes.length);
  return { contentType: `multipart/form-data; boundary=${boundary}`, body };
}
