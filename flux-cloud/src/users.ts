import { Pool } from 'pg';
import { getPool, migrate } from './db';
import { hashPassword, verifyPassword, generateToken, hashToken, verifyTokenHash, generateTenantId } from './security';

export type TenantSummary = {
  tenantId: string;
  label: string;
  accessToken?: string;
};

export type RegisteredTenant = TenantSummary & {
  tunnelToken: string;
  accessToken: string;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class TenantStore {
  private pool: Pool;

  constructor(databaseUrl: string) {
    this.pool = getPool(databaseUrl);
  }

  async init(): Promise<void> {
    await migrate(this.pool);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async ready(): Promise<void> {
    await this.pool.query('SELECT 1');
  }

  async registerUser(email: string, password: string, label?: string): Promise<RegisteredTenant> {
    const normalizedEmail = email.trim().toLowerCase();
    if (!EMAIL_RE.test(normalizedEmail)) {
      throw new Error('Invalid email address');
    }
    if (typeof password !== 'string' || password.length < 8) {
      throw new Error('Password must be at least 8 characters');
    }

    const passwordHash = hashPassword(password);
    const tenantId = generateTenantId();
    const token = generateToken();
    const tenantLabel = label?.trim() || normalizedEmail;

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const userResult = await client.query<{ id: number }>(
        'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id',
        [normalizedEmail, passwordHash]
      );
      const userId = userResult.rows[0].id;

      await client.query(
        'INSERT INTO tenants (tenant_id, user_id, token_hash, label) VALUES ($1, $2, $3, $4)',
        [tenantId, userId, hashToken(token), tenantLabel]
      );

      const accessToken = generateToken();
      await client.query(
        'INSERT INTO sessions (token_hash, user_id, tenant_id, expires_at) VALUES ($1, $2, $3, now() + interval \'30 days\')',
        [hashToken(accessToken), userId, tenantId]
      );

      await client.query('COMMIT');
      return { tenantId, tunnelToken: token, accessToken, label: tenantLabel };
    } catch (error) {
      await client.query('ROLLBACK');
      if (error instanceof Error && /unique/i.test(error.message)) {
        throw new Error('Email is already registered');
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async login(email: string, password: string): Promise<TenantSummary[]> {
    const normalizedEmail = email.trim().toLowerCase();
    const userResult = await this.pool.query<{ id: number; password_hash: string }>(
      'SELECT id, password_hash FROM users WHERE email = $1',
      [normalizedEmail]
    );
    const user = userResult.rows[0];
    if (!user || !verifyPassword(password, user.password_hash)) {
      throw new Error('Invalid email or password');
    }

    const tenantsResult = await this.pool.query<{ tenant_id: string; label: string }>(
      'SELECT tenant_id, label FROM tenants WHERE user_id = $1 ORDER BY created_at ASC',
      [user.id]
    );
    return await Promise.all(tenantsResult.rows.map(async (row) => ({
      tenantId: row.tenant_id,
      label: row.label,
      accessToken: await this.createSession(user.id, row.tenant_id),
    })));
  }

  async addTenant(email: string, password: string, label?: string): Promise<RegisteredTenant> {
    const normalizedEmail = email.trim().toLowerCase();
    const userResult = await this.pool.query<{ id: number; password_hash: string }>(
      'SELECT id, password_hash FROM users WHERE email = $1',
      [normalizedEmail]
    );
    const user = userResult.rows[0];
    if (!user || !verifyPassword(password, user.password_hash)) {
      throw new Error('Invalid email or password');
    }

    const tenantId = generateTenantId();
    const token = generateToken();
    const tenantLabel = label?.trim() || normalizedEmail;

    await this.pool.query(
      'INSERT INTO tenants (tenant_id, user_id, token_hash, label) VALUES ($1, $2, $3, $4)',
      [tenantId, user.id, hashToken(token), tenantLabel]
    );

    return { tenantId, tunnelToken: token, accessToken: await this.createSession(user.id, tenantId), label: tenantLabel };
  }

  async exists(tenantId: string): Promise<boolean> {
    const result = await this.pool.query('SELECT 1 FROM tenants WHERE tenant_id = $1', [tenantId]);
    return (result.rowCount ?? 0) > 0;
  }

  async verifyToken(tenantId: string, token: string): Promise<boolean> {
    const result = await this.pool.query<{ token_hash: string }>(
      'SELECT token_hash FROM tenants WHERE tenant_id = $1',
      [tenantId]
    );
    const row = result.rows[0];
    if (!row) return false;
    return verifyTokenHash(token, row.token_hash);
  }

  async verifyAccessToken(tenantId: string, token: string): Promise<boolean> {
    return (await this.getAccessTokenUser(tenantId, token)) !== undefined;
  }

  async getAccessTokenUser(tenantId: string, token: string): Promise<string | undefined> {
    const result = await this.pool.query(
      `SELECT users.email
       FROM sessions
       JOIN users ON users.id = sessions.user_id
       WHERE sessions.token_hash = $1 AND sessions.tenant_id = $2 AND sessions.expires_at > now()`,
      [hashToken(token), tenantId]
    );
    return result.rows[0]?.email;
  }

  private async createSession(userId: number, tenantId: string): Promise<string> {
    const accessToken = generateToken();
    await this.pool.query(
      'INSERT INTO sessions (token_hash, user_id, tenant_id, expires_at) VALUES ($1, $2, $3, now() + interval \'30 days\')',
      [hashToken(accessToken), userId, tenantId]
    );
    return accessToken;
  }
}
