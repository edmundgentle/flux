import fs from 'node:fs';
import path from 'node:path';

export type AppConfig = {
  port: number;
  host: string;
  databaseUrl: string;
  wsPath: string;
  corsOrigins: string[];
};

export function loadConfig(): AppConfig {
  const envFile = path.resolve(process.cwd(), '.env');
  if (fs.existsSync(envFile)) {
    const values = fs.readFileSync(envFile, 'utf8').split(/\r?\n/);
    for (const line of values) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx === -1) continue;
      const key = trimmed.slice(0, idx).trim();
      const value = trimmed.slice(idx + 1).trim();
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL environment variable is required to store tenants and users');
  }

  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be an integer between 1 and 65535 (got: ${process.env.PORT ?? '3000'})`);
  }

  const host = (process.env.HOST || '0.0.0.0').trim();
  if (!host) {
    throw new Error('HOST environment variable must not be empty');
  }

  return {
    port,
    host,
    databaseUrl,
    wsPath: (process.env.WS_PATH || '/ws').trim() || '/ws',
    corsOrigins: (process.env.CORS_ORIGINS || '').split(',').map((origin) => origin.trim()).filter(Boolean),
  };
}
