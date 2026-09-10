import { Pool } from 'pg';

let pool: Pool | undefined;

export function getPool(databaseUrl: string): Pool {
  const isLocal = /localhost|127\.0\.0\.1/.test(databaseUrl);
  const connectionString = isLocal ? databaseUrl : withoutSslMode(databaseUrl);

  if (!pool) {
    pool = new Pool({
      connectionString,
      ssl: isLocal
        ? false
        : process.env.DATABASE_CA_CERT
          ? { rejectUnauthorized: true, ca: process.env.DATABASE_CA_CERT }
          : { rejectUnauthorized: false },
    });
  }
  return pool;
}

function withoutSslMode(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.searchParams.delete('sslmode');
  return url.toString();
}

export async function migrate(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Migrate the legacy "tenants" naming to "instances" in place, preserving existing data.
  await pool.query(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'tenants')
        AND NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'instances') THEN
        ALTER TABLE tenants RENAME TO instances;
      END IF;
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'instances' AND column_name = 'tenant_id') THEN
        ALTER TABLE instances RENAME COLUMN tenant_id TO instance_id;
      END IF;
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'sessions' AND column_name = 'tenant_id') THEN
        ALTER TABLE sessions RENAME COLUMN tenant_id TO instance_id;
      END IF;
    END $$;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS instances (
      instance_id TEXT PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL,
      label TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Instances may now be self-provisioned by a device before being claimed by a user account.
  await pool.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'instances' AND column_name = 'user_id' AND is_nullable = 'NO'
      ) THEN
        ALTER TABLE instances ALTER COLUMN user_id DROP NOT NULL;
      END IF;
    END $$;
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS instances_user_id_idx ON instances (user_id);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      instance_id TEXT NOT NULL REFERENCES instances(instance_id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions (user_id);
  `);

  // Members allow multiple end-user accounts to be tied to a single instance (e.g. a
  // household), separately from the single owning user in instances.user_id. An email can
  // only ever be tied to one instance (enforced by the unique index), whether pending
  // (joined_at IS NULL, invited but not yet registered) or joined.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS instance_members (
      id SERIAL PRIMARY KEY,
      instance_id TEXT NOT NULL REFERENCES instances(instance_id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      invited_email TEXT NOT NULL,
      invited_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      joined_at TIMESTAMPTZ
    );
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS instance_members_email_idx ON instance_members (invited_email);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS instance_members_instance_id_idx ON instance_members (instance_id);
  `);
}
