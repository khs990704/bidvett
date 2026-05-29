/**
 * Supabase service_role client. Server-only. Bypasses RLS.
 * Used for credit_ledger inserts, subscriptions upserts, system_prompts reads,
 * and any operation that requires admin privileges.
 */
// NOTE: Server-only. Never import this from a 'use client' module —
// `serverEnv()` will throw if accessed from a client bundle.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { publicEnv, serverEnv } from '@/lib/env';

let _admin: SupabaseClient | null = null;

export function supabaseAdmin(): SupabaseClient {
  if (_admin) return _admin;
  _admin = createClient(
    publicEnv.NEXT_PUBLIC_SUPABASE_URL,
    serverEnv().SUPABASE_SERVICE_ROLE_KEY,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    },
  );
  return _admin;
}
