'use client';

import { SupabaseAuthClient, TrackingClient } from '@transitlink/shared';

// Dispatcher/admin access to the tracking server. Session is kept in sessionStorage (cleared when the
// tab closes) rather than localStorage, since admin tokens can change stop and route configuration.

export const TRACKING_API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
const KEY = 'transitlink.session';

let auth: SupabaseAuthClient | null = null;
let client: TrackingClient | null = null;

export function getAuth(): SupabaseAuthClient {
  if (auth) return auth;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error('Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY in .env.local');
  auth = new SupabaseAuthClient(url, key, {
    get: () => sessionStorage.getItem(KEY),
    set: (v) => sessionStorage.setItem(KEY, v),
    clear: () => sessionStorage.removeItem(KEY),
  });
  return auth;
}

/**
 * LOCAL DEVELOPMENT ONLY: a `dev:<uuid>` token accepted by the tracking server's dev mode
 * (`npm run dev:local`), so the pages work without a Supabase project. Ignored in production builds.
 */
export const DEV_TOKEN = process.env.NODE_ENV !== 'production' ? process.env.NEXT_PUBLIC_DEV_TOKEN || null : null;

export function getTracking(): TrackingClient {
  client ??= new TrackingClient(TRACKING_API_URL, () => (DEV_TOKEN ? Promise.resolve(DEV_TOKEN) : getAuth().getAccessToken()));
  return client;
}
