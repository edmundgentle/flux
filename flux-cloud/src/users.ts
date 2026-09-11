import { Pool } from 'pg';
import { getPool, migrate } from './db';
import { hashPassword, verifyPassword, generateToken, hashToken, verifyTokenHash, generateInstanceId } from './security';
import { sendInviteEmail } from './email';

export type InstanceSummary = {
  instanceId: string;
  label: string;
  accessToken?: string;
};

export type RegisteredInstance = InstanceSummary & {
  tunnelToken?: string;
  accessToken: string;
};

export type InstanceMember = {
  email: string;
  joined: boolean;
  invitedAt: string;
  joinedAt: string | null;
};

export type InviteOutcome = {
  status: 'invited' | 'joined' | 'already_member';
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

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const userResult = await client.query<{ id: number }>(
        'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id',
        [normalizedEmail, passwordHash]
      );
      const userId = userResult.rows[0].id;

      // If this email was invited to an existing instance, join it instead of provisioning a
      // brand new one.
      const inviteResult = await client.query<{ instance_id: string; label: string }>(
        `SELECT instances.instance_id, instances.label
         FROM instance_members
         JOIN instances ON instances.instance_id = instance_members.instance_id
         WHERE instance_members.invited_email = $1 AND instance_members.joined_at IS NULL
         FOR UPDATE OF instance_members`,
        [normalizedEmail]
      );
      const pendingInvite = inviteResult.rows[0];

      let instanceId: string;
      let instanceLabel: string;
      let tunnelToken: string | undefined;

      if (pendingInvite) {
        instanceId = pendingInvite.instance_id;
        instanceLabel = pendingInvite.label;
        await client.query(
          'UPDATE instance_members SET user_id = $1, joined_at = now() WHERE instance_id = $2 AND invited_email = $3',
          [userId, instanceId, normalizedEmail]
        );
      } else {
        instanceId = generateInstanceId();
        const token = generateToken();
        tunnelToken = token;
        instanceLabel = label?.trim() || normalizedEmail;
        await client.query(
          'INSERT INTO instances (instance_id, user_id, token_hash, label) VALUES ($1, $2, $3, $4)',
          [instanceId, userId, hashToken(token), instanceLabel]
        );
        await client.query(
          'INSERT INTO instance_members (instance_id, user_id, invited_email, joined_at) VALUES ($1, $2, $3, now())',
          [instanceId, userId, normalizedEmail]
        );
      }

      const accessToken = generateToken();
      await client.query(
        'INSERT INTO sessions (token_hash, user_id, instance_id, expires_at) VALUES ($1, $2, $3, now() + interval \'30 days\')',
        [hashToken(accessToken), userId, instanceId]
      );

      await client.query('COMMIT');
      return { instanceId, tunnelToken, accessToken, label: instanceLabel };
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

    await this.pool.query(
      'UPDATE instance_members SET user_id = $1, joined_at = COALESCE(joined_at, now()) WHERE invited_email = $2 AND user_id IS NULL',
      [user.id, normalizedEmail]
    );

    const instancesResult = await this.pool.query<{ instance_id: string; label: string }>(
      `SELECT instance_id, label
       FROM instances
       WHERE user_id = $1
          OR instance_id IN (
            SELECT instance_id FROM instance_members WHERE user_id = $1 OR invited_email = $2
          )
       ORDER BY created_at ASC`,
      [user.id, normalizedEmail]
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

  /** Returns an instance's display label, shown to its members (e.g. "Smith House"). */
  async getInstanceLabel(instanceId: string): Promise<string | undefined> {
    const result = await this.pool.query<{ label: string }>(
      'SELECT label FROM instances WHERE instance_id = $1',
      [instanceId]
    );
    return result.rows[0]?.label;
  }

  async renameInstance(instanceId: string, label: string): Promise<string> {
    const trimmed = label.trim().slice(0, 128);
    if (!trimmed) {
      throw new Error('Instance name cannot be empty');
    }
    const result = await this.pool.query(
      'UPDATE instances SET label = $1 WHERE instance_id = $2',
      [trimmed, instanceId]
    );
    if ((result.rowCount ?? 0) === 0) {
      throw new Error('Instance not found');
    }
    return trimmed;
  }

  async listMembers(instanceId: string): Promise<InstanceMember[]> {
    const result = await this.pool.query<{ invited_email: string; invited_at: string; joined_at: string | null }>(
      'SELECT invited_email, invited_at, joined_at FROM instance_members WHERE instance_id = $1 ORDER BY invited_at ASC',
      [instanceId]
    );
    return result.rows.map((row) => ({
      email: row.invited_email,
      joined: row.joined_at !== null,
      invitedAt: row.invited_at,
      joinedAt: row.joined_at,
    }));
  }

  /**
   * Ties an email to this instance: assigns it immediately if the email already has a
   * registered account, otherwise records a pending invite and sends an invite email. An
   * email can only ever be tied to one instance, whether pending or joined.
   */
  async inviteOrAssignMember(instanceId: string, email: string): Promise<InviteOutcome> {
    const normalizedEmail = email.trim().toLowerCase();
    if (!EMAIL_RE.test(normalizedEmail)) {
      throw new Error('Invalid email address');
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const existing = await client.query<{ instance_id: string }>(
        'SELECT instance_id FROM instance_members WHERE invited_email = $1 FOR UPDATE',
        [normalizedEmail]
      );
      const existingRow = existing.rows[0];
      if (existingRow) {
        await client.query('ROLLBACK');
        if (existingRow.instance_id !== instanceId) {
          throw new Error('This email is already tied to a different instance');
        }
        return { status: 'already_member' };
      }

      const userResult = await client.query<{ id: number }>(
        'SELECT id FROM users WHERE email = $1',
        [normalizedEmail]
      );
      const existingUser = userResult.rows[0];

      await client.query(
        `INSERT INTO instance_members (instance_id, user_id, invited_email, joined_at)
         VALUES ($1, $2, $3, $4)`,
        [instanceId, existingUser?.id ?? null, normalizedEmail, existingUser ? new Date() : null]
      );

      await client.query('COMMIT');

      if (existingUser) {
        return { status: 'joined' };
      }

      const label = (await this.getInstanceLabel(instanceId)) || 'Flux instance';
      await sendInviteEmail({ to: normalizedEmail, instanceLabel: label });
      return { status: 'invited' };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
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
