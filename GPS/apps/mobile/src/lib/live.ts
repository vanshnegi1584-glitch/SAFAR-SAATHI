import { SupabaseAuthClient, TrackingClient } from '@transitlink/shared';
import * as SecureStore from 'expo-secure-store';

// Live mode: Supabase login + the tracking server. Mock mode keeps the original demo flow untouched.

export const isLive = () => process.env.EXPO_PUBLIC_DATA_SOURCE === 'live';

export const TRACKING_API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:4000';
const SESSION_KEY = 'transitlink.session';

let auth: SupabaseAuthClient | null = null;
let client: TrackingClient | null = null;

export function getAuth(): SupabaseAuthClient {
  if (auth) return auth;
  const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
  const key = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error('Set EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY in apps/mobile/.env.local');
  // Tokens live in the OS keychain/keystore, not plain AsyncStorage.
  auth = new SupabaseAuthClient(url, key, {
    get: () => SecureStore.getItemAsync(SESSION_KEY),
    set: (v) => SecureStore.setItemAsync(SESSION_KEY, v),
    clear: () => SecureStore.deleteItemAsync(SESSION_KEY),
  });
  return auth;
}

export function getTracking(): TrackingClient {
  client ??= new TrackingClient(TRACKING_API_URL, () => getAuth().getAccessToken());
  return client;
}
