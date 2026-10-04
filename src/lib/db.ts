import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite, type Transaction } from '@electric-sql/pglite';
import { settings } from './config';
import { MIGRATIONS } from './migrations';

// An embedded Postgres (PGlite) stored under DATA_DIR, so there is no database to install. The
// web server and the background poller share one process and one connection.
export type DB = { query: (sql: string, values?: unknown[]) => Promise<{ rows: unknown[] }> };

const g = globalThis as unknown as { benchDb?: Promise<PGlite> };
function open() {
  g.benchDb ??= (async () => {
    const dir = resolve(settings().dataDir, 'db');
    mkdirSync(dir, { recursive: true });
    const db = await PGlite.create(dir);
    await migrate(db);
    return db;
  })();
  return g.benchDb;
}

async function migrate(db: PGlite) {
  await db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const done = new Set((await db.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
  for (const [name, sql] of MIGRATIONS) {
    if (done.has(name)) continue;
    await db.transaction(async (tx) => {
      await tx.exec(sql);
      await tx.query('INSERT INTO schema_migrations(name) VALUES($1)', [name]);
    });
  }
}

export const pool: DB = {
  async query(sql, values = []) {
    return (await open()).query(sql, values);
  },
};

export async function rows<T>(sql: string, values: unknown[] = [], db: DB = pool): Promise<T[]> {
  return (await db.query(sql, values)).rows as T[];
}
export async function one<T>(sql: string, values: unknown[] = [], db: DB = pool): Promise<T> {
  const row = (await rows<T>(sql, values, db))[0];
  if (!row) throw new Error('Record not found');
  return row;
}
export async function transaction<T>(fn: (db: DB) => Promise<T>): Promise<T> {
  return (await open()).transaction((tx: Transaction) => fn(tx));
}
export async function audit(db: DB, action: string, entityId: string | null, details: unknown = {}) {
  await db.query('INSERT INTO audit_log(action,entity_id,details) VALUES($1,$2,$3)', [
    action,
    entityId,
    JSON.stringify(details),
  ]);
}
