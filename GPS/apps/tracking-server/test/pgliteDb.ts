import { PGlite } from '@electric-sql/pglite';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from '../src/db';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Runs the real Supabase migrations from the database repo ("Bus Management System") inside PGlite
// (Postgres compiled to WASM), so SQL and RLS are exercised without Docker. Only the pieces Supabase
// provides itself — the auth schema and the realtime publication — are stubbed.

export const MIGRATIONS_DIR = resolve(
  process.env.SAFARSAATHI_DB_REPO ?? resolve(__dirname, '../../../../Bus Management System'),
  'supabase/migrations',
);
export const hasMigrations = existsSync(MIGRATIONS_DIR);

const SUPABASE_STUBS = `
  create schema if not exists auth;
  create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}'::jsonb);
  create or replace function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create publication supabase_realtime;
`;

export async function createTestDb(): Promise<{ db: Db; pg: PGlite }> {
  const pg = new PGlite();
  await pg.exec(SUPABASE_STUBS);
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
    // gen_random_uuid() is built into Postgres 13+; PGlite has no pgcrypto extension to create.
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8').replace(/create extension if not exists "pgcrypto";/i, '');
    try {
      await pg.exec(sql);
    } catch (e) {
      throw new Error(`Migration ${file} failed: ${(e as Error).message}`);
    }
  }
  const db: Db = {
    query: async (text, params) => {
      const r = await pg.query(text, params as unknown[]);
      return { rows: r.rows as never[] };
    },
    transaction: (fn) => pg.transaction((t) => {
      const tx: Db = {
        query: async (text, params) => ({ rows: (await t.query(text, params as unknown[])).rows as never[] }),
        transaction: (inner) => inner(tx),
      };
      return fn(tx);
    }),
  };
  return { db, pg };
}

/** Creates an auth user (the signup trigger makes the profile), then sets its role as an admin would. */
export async function createUser(db: Db, id: string, role: string, meta: Record<string, unknown> = {}) {
  await db.query('insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)', [id, `${id.slice(0, 8)}@test.local`, JSON.stringify(meta)]);
  await db.query('update public.profiles set role = $2 where id = $1', [id, role]);
}
