import pg from 'pg';

/** The only database surface the server uses — satisfied by a pg Pool in production and PGlite in tests. */
export interface Db {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
  /** Runs `fn` in one transaction; rolls back if it throws. */
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
}

export function createPgDb(connectionString: string): Db & { end(): Promise<void> } {
  const pool = new pg.Pool({ connectionString, max: 10 });
  pool.on('error', (e) => console.error('[db] idle client error', e.message));
  return {
    query: (text, params) => pool.query(text, params as unknown[]) as never,
    transaction: async (fn) => {
      const client = await pool.connect();
      const tx: Db = {
        query: (text, params) => client.query(text, params as unknown[]) as never,
        transaction: (inner) => inner(tx),
      };
      try {
        await client.query('begin');
        const out = await fn(tx);
        await client.query('commit');
        return out;
      } catch (e) {
        await client.query('rollback');
        throw e;
      } finally {
        client.release();
      }
    },
    end: () => pool.end(),
  };
}
