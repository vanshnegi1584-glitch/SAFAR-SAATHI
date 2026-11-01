import { createClient, SupabaseClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { Database } from './types/database.types.js';

dotenv.config();

export type SafarSaathiClient = SupabaseClient<Database>;

export interface SupabaseConfig {
  supabaseUrl?: string;
  supabaseKey?: string;
}

/**
 * Creates and returns a strongly-typed Supabase client for SafarSaathi.
 */
export function createSafarSaathiClient(config?: SupabaseConfig): SafarSaathiClient {
  const supabaseUrl = config?.supabaseUrl || process.env.SUPABASE_URL || 'http://127.0.0.1:54321';
  const supabaseKey = config?.supabaseKey || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key';

  return createClient<Database>(supabaseUrl, supabaseKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

export const supabase = createSafarSaathiClient();
