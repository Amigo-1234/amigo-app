import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./database.types";

/**
 * The PostgREST + auth client the Supabase source talks to. With
 * VITE_DATA_SOURCE=neon it's Neon's Supabase-compatible client instead (Neon
 * Auth + Data API, see ./neonClient.ts), so the same queries and RPCs run
 * against Neon. Neon has no Realtime or Storage; callers check `isNeon`.
 */
export const isNeon = import.meta.env.VITE_DATA_SOURCE === "neon";

export const supabase: SupabaseClient<Database> = isNeon ? (await import("./neonClient")).neonClient : createSupabase();

function createSupabase(): SupabaseClient<Database> {
  const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  // Supabase's new publishable key (sb_publishable_…) or the legacy anon JWT — both are public.
  const key = (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? import.meta.env.VITE_SUPABASE_ANON_KEY) as string | undefined;
  if (!url || !key) {
    throw new Error(
      "Supabase is selected (VITE_DATA_SOURCE=supabase) but VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY are not set. See .env.example.",
    );
  }
  return createClient<Database>(url, key, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: "pkce" },
    realtime: { params: { eventsPerSecond: 5 } },
  });
}
