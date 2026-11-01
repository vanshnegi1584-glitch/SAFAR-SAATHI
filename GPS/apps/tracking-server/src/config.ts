import {
  DEFAULT_ETA_POLICY, DEFAULT_FIX_POLICY, DEFAULT_FRESHNESS, DEFAULT_PROGRESS_POLICY,
  type EtaPolicy, type FixPolicy, type FreshnessConfig, type ProgressPolicy,
} from '@transitlink/shared';
import { parseSeatSources } from './seats';

export interface ServerConfig {
  port: number;
  databaseUrl: string | null;
  supabaseUrl: string | null;
  supabaseAnonKey: string | null;
  /** Local development only: accept `dev:<profile uuid>` bearer tokens. Refused in production. */
  devAuth: boolean;
  corsOrigins: string[];
  retentionDays: number;
  nominatimUrl: string;
  osrmUrl: string;
  /** Identifies the app to OSM services, as their usage policies require. */
  geoUserAgent: string;
  timezone: string;
  /** Bus id → base URL of that bus's vision fusion service (ai_face). Empty = seat counts off. */
  seatSources: Record<string, string>;
  fix: FixPolicy;
  progress: ProgressPolicy;
  freshness: FreshnessConfig;
  eta: EtaPolicy;
}

const num = (v: string | undefined, d: number) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const devAuth = env.DEV_AUTH === '1';
  if (devAuth && env.NODE_ENV === 'production') throw new Error('DEV_AUTH=1 is not allowed when NODE_ENV=production');
  return {
    port: num(env.PORT, 4000),
    databaseUrl: env.DATABASE_URL || null,
    supabaseUrl: env.SUPABASE_URL || null,
    supabaseAnonKey: env.SUPABASE_ANON_KEY || null,
    devAuth,
    corsOrigins: (env.CORS_ORIGINS ?? 'http://localhost:3000,http://localhost:8081').split(',').map((s) => s.trim()).filter(Boolean),
    retentionDays: num(env.LOCATION_RETENTION_DAYS, 30),
    nominatimUrl: env.NOMINATIM_URL || 'https://nominatim.openstreetmap.org',
    osrmUrl: env.OSRM_URL || 'https://router.project-osrm.org',
    geoUserAgent: env.GEO_USER_AGENT || 'SafarSaathi-campus-bus-admin/0.1 (set GEO_USER_AGENT with a contact email)',
    timezone: env.SCHEDULE_TIMEZONE || 'Asia/Kolkata',
    seatSources: parseSeatSources(env.SEAT_SOURCES),
    fix: { ...DEFAULT_FIX_POLICY },
    progress: { ...DEFAULT_PROGRESS_POLICY },
    freshness: {
      liveMaxSec: num(env.FRESHNESS_LIVE_SEC, DEFAULT_FRESHNESS.liveMaxSec),
      delayedMaxSec: num(env.FRESHNESS_DELAYED_SEC, DEFAULT_FRESHNESS.delayedMaxSec),
      offlineAfterSec: num(env.FRESHNESS_OFFLINE_SEC, DEFAULT_FRESHNESS.offlineAfterSec),
    },
    eta: { ...DEFAULT_ETA_POLICY, baselineKmh: num(env.ETA_BASELINE_KMH, DEFAULT_ETA_POLICY.baselineKmh) },
  };
}
