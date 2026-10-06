import { createClient } from "@supabase/supabase-js";
import type { Database } from "./database.types";

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
// Supabase's new publishable key (sb_publishable_…) or the legacy anon JWT — both are public.
const key = (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? import.meta.env.VITE_SUPABASE_ANON_KEY) as string | undefined;

if (!url || !key) {
  throw new Error(
    "Supabase is selected (VITE_DATA_SOURCE=supabase) but VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY are not set. See .env.example.",
  );
}

export const supabase = createClient<Database>(url, key, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: "pkce" },
  realtime: { params: { eventsPerSecond: 5 } },
});
