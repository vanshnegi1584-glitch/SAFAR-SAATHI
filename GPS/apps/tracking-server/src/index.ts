import { createTrackingServer } from './app';
import { DevAuthenticator, SupabaseAuthenticator, type Authenticator } from './auth';
import { loadConfig } from './config';
import { createPgDb } from './db';

const cfg = loadConfig();
if (!cfg.databaseUrl) {
  console.error('DATABASE_URL is required (Supabase → Project Settings → Database → connection string). See .env.example.');
  process.exit(1);
}
const db = createPgDb(cfg.databaseUrl);

let auth: Authenticator;
if (cfg.devAuth) {
  console.warn('[auth] DEV_AUTH=1 — accepting dev:<uuid> tokens. Never enable this outside local development.');
  auth = new DevAuthenticator(db);
} else if (cfg.supabaseUrl && cfg.supabaseAnonKey) {
  auth = new SupabaseAuthenticator(db, cfg.supabaseUrl, cfg.supabaseAnonKey);
} else {
  console.error('SUPABASE_URL and SUPABASE_ANON_KEY are required to verify logins.');
  process.exit(1);
}

const server = await createTrackingServer(db, auth, cfg);
server.http.listen(cfg.port, () => console.log(`[tracking] listening on :${cfg.port}`));
server.seats.start();
if (server.seats.configured) console.log(`[seats] polling ${server.seats.configured} bus vision service(s)`);

const sweep = setInterval(() => void server.tracker.sweep().catch((e) => console.error('[sweep]', e)), 1000);
const metrics = setInterval(() => {
  const s = server.tracker.takeLatencyStats();
  if (s) console.log(`[latency] GPS measurement → server: n=${s.count} p50=${s.p50}ms p95=${s.p95}ms max=${s.max}ms`);
}, 60_000);
const purge = async () => {
  try {
    const n = await server.repo.purgeHistory(cfg.retentionDays);
    if (n) console.log(`[retention] removed ${n} location samples older than ${cfg.retentionDays} days`);
  } catch (e) {
    console.error('[retention]', (e as Error).message);
  }
};
void purge();
const retention = setInterval(purge, 6 * 3600_000);

const shutdown = async () => {
  server.seats.stop();
  clearInterval(sweep);
  clearInterval(metrics);
  clearInterval(retention);
  await server.close();
  await db.end();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
