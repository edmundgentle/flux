import crypto from 'node:crypto';

const SCRYPT_KEYLEN = 64;

// Format: <salt-hex>:<derived-key-hex>
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
  return `${salt}:${derived}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, key] = stored.split(':');
  if (!salt || !key) return false;

  const derived = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
  const keyBuffer = Buffer.from(key, 'hex');
  if (keyBuffer.length !== derived.length) return false;
  return crypto.timingSafeEqual(derived, keyBuffer);
}

export function generateToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function verifyTokenHash(token: string, storedHash: string): boolean {
  const candidate = Buffer.from(hashToken(token), 'hex');
  const stored = Buffer.from(storedHash, 'hex');
  if (candidate.length !== stored.length) return false;
  return crypto.timingSafeEqual(candidate, stored);
}

export function generateTenantId(): string {
  return `tenant_${crypto.randomBytes(8).toString('hex')}`;
}
