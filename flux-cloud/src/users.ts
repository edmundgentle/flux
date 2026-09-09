import { Pool } from 'pg';
import { getPool, migrate } from './db';
import { hashPassword, verifyPassword, generateToken, hashToken, verifyTokenHash, generateInstanceId } from './security';

export type InstanceSummary = {
  instanceId: string;
  label: string;
  accessToken?: string;
};

export type RegisteredInstance = InstanceSummary & {
  tunnelToken: string;
  accessToken: string;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class UserStore {
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

  async registerUser(email: string, password: string, label?: string): Promise<RegisteredInstance> {
    const normalizedEmail = email.trim().toLowerCase();
    if (!EMAIL_RE.test(normalizedEmail)) {
      throw new Error('Invalid email address');
    }
    if (typeof password !== 'string' || password.length < 8) {
      throw new Error('Password must be at least 8 characters');
    }

    const passwordHash = hashPassword(password);
    const instanceId = generateInstanceId();
    const token = generateToken();
    const instanceLabel = label?.trim() || normalizedEmail;

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const userResult = await client.query<{ id: number }>(
        'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id',
        [normalizedEmail, passwordHash]
      );
      const userId = userResult.rows[0].id;

      await client.query(
        'INSERT INTO instances (instance_id, user_id, token_hash, label) VALUES ($1, $2, $3, $4)',
        [instanceId, userId, hashToken(token), instanceLabel]
      );

      const accessToken = generateToken();
      await client.query(
        'INSERT INTO sessions (token_hash, user_id, instance_id, expires_at) VALUES ($1, $2, $3, now() + interval \'30 days\')',
        [hashToken(accessToken), userId, instanceId]
      );

      await client.query('COMMIT');
      return { instanceId, tunnelToken: token, accessToken, label: instanceLabel };
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

  async login(email: string, password: string): Promise<InstanceSummary[]> {
    const normalizedEmail = email.trim().toLowerCase();
    const userResult = await this.pool.query<{ id: number; password_hash: string }>(
      'SELECT id, password_hash FROM users WHERE email = $1',
      [normalizedEmail]
    );
    const user = userResult.rows[0];
    if (!user || !verifyPassword(password, user.password_hash)) {
      throw new Error('Invalid email or password');
    }

    const instancesResult = await this.pool.query<{ instance_id: string; label: string }>(
      'SELECT instance_id, label FROM instances WHERE user_id = $1 ORDER BY created_at ASC',
      [user.id]
    );
    return await Promise.all(instancesResult.rows.map(async (row) => ({
      instanceId: row.instance_id,
      label: row.label,
      accessToken: await this.createSession(user.id, row.instance_id),
    })));
  }

  /**
   * Self-provisions a brand new, unclaimed instance with no associated user account,
   * so a device (e.g. a Home Assistant add-on) can obtain relay credentials on first boot
   * without requiring the user to sign in or configure anything.
   */
  async provisionInstance(label?: string): Promise<InstanceSummary & { tunnelToken: string }> {
    const instanceId = generateInstanceId();
    const token = generateToken();
    const instanceLabel = (label?.trim() || 'Unclaimed device').slice(0, 128);

    await this.pool.query(
      'INSERT INTO instances (instance_id, user_id, token_hash, label) VALUES ($1, NULL, $2, $3)',
      [instanceId, hashToken(token), instanceLabel]
    );

    return { instanceId, tunnelToken: token, label: instanceLabel };
  }

  async addInstance(email: string, password: string, label?: string): Promise<RegisteredInstance> {
    const normalizedEmail = email.trim().toLowerCase();
    const userResult = await this.pool.query<{ id: number; password_hash: string }>(
      'SELECT id, password_hash FROM users WHERE email = $1',
      [normalizedEmail]
    );
    const user = userResult.rows[0];
    if (!user || !verifyPassword(password, user.password_hash)) {
      throw new Error('Invalid email or password');
    }

    const instanceId = generateInstanceId();
    const token = generateToken();
    const instanceLabel = label?.trim() || normalizedEmail;

    await this.pool.query(
      'INSERT INTO instances (instance_id, user_id, token_hash, label) VALUES ($1, $2, $3, $4)',
      [instanceId, user.id, hashToken(token), instanceLabel]
    );

    return { instanceId, tunnelToken: token, accessToken: await this.createSession(user.id, instanceId), label: instanceLabel };
  }

  async exists(instanceId: string): Promise<boolean> {
    const result = await this.pool.query('SELECT 1 FROM instances WHERE instance_id = $1', [instanceId]);
    return (result.rowCount ?? 0) > 0;
  }

  async verifyToken(instanceId: string, token: string): Promise<boolean> {
    const result = await this.pool.query<{ token_hash: string }>(
      'SELECT token_hash FROM instances WHERE instance_id = $1',
      [instanceId]
    );
    const row = result.rows[0];
    if (!row) return false;
    return verifyTokenHash(token, row.token_hash);
  }

  async verifyAccessToken(instanceId: string, token: string): Promise<boolean> {
    return (await this.getAccessTokenUser(instanceId, token)) !== undefined;
  }

  async getAccessTokenUser(instanceId: string, token: string): Promise<string | undefined> {
    const result = await this.pool.query(
      `SELECT users.email
       FROM sessions
       JOIN users ON users.id = sessions.user_id
       WHERE sessions.token_hash = $1 AND sessions.instance_id = $2 AND sessions.expires_at > now()`,
      [hashToken(token), instanceId]
    );
    return result.rows[0]?.email;
  }

  private async createSession(userId: number, instanceId: string): Promise<string> {
    const accessToken = generateToken();
    await this.pool.query(
      'INSERT INTO sessions (token_hash, user_id, instance_id, expires_at) VALUES ($1, $2, $3, now() + interval \'30 days\')',
      [hashToken(accessToken), userId, instanceId]
    );
    return accessToken;
  }
}
