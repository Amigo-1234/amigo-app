/**
 * legacy-sign-in — lets people migrated from Firebase keep their password.
 *
 * Firebase stores passwords with a modified scrypt that Supabase Auth cannot
 * import (it accepts bcrypt/argon2 only). So migrated accounts are created
 * without a password. When such a person signs in and Supabase rejects the
 * password, the app calls this function, which:
 *
 *   1. checks the email belongs to a migrated account that has not set a
 *      Supabase password yet (legacy.user_map.password_migrated_at is null);
 *   2. verifies the password with Firebase Auth's own sign-in endpoint and
 *      checks the Firebase uid matches the one recorded at migration;
 *   3. sets that password on the Supabase account (bcrypt-hashed by Supabase).
 *      A trigger then marks the account as migrated, so this path closes for
 *      that person forever.
 *
 * The password is never stored or logged here. Every failure returns the same
 * response, so the function can't be used to probe which emails exist.
 *
 * Secrets (supabase secrets set …):
 *   LEGACY_SIGNIN_ENABLED=true     kill switch — anything else disables it
 *   FIREBASE_WEB_API_KEY=…         the public web API key of amigo-world-ebfab
 * SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by the platform.
 */
import { createClient } from "npm:@supabase/supabase-js@2";

const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") ?? "").split(",").map((s) => s.trim()).filter(Boolean);

function cors(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  const allow = ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin) ? origin || "*" : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
}

const json = (req: Request, body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors(req), "Content-Type": "application/json" } });

// Same answer for unknown email, already-migrated account and wrong password.
const NO_MATCH = { status: "no_match" };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  if (req.method !== "POST") return json(req, { status: "method_not_allowed" }, 405);
  if (Deno.env.get("LEGACY_SIGNIN_ENABLED") !== "true") return json(req, { status: "disabled" });

  const firebaseKey = Deno.env.get("FIREBASE_WEB_API_KEY");
  if (!firebaseKey) return json(req, { status: "misconfigured" }, 500);

  let email = "";
  let password = "";
  try {
    const body = await req.json();
    email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    password = typeof body.password === "string" ? body.password : "";
  } catch {
    return json(req, NO_MATCH);
  }
  if (!email || email.length > 320 || password.length < 6 || password.length > 128) return json(req, NO_MATCH);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: rows, error: lookupError } = await admin.rpc("legacy_find_unmigrated_user", { p_email: email });
  if (lookupError) return json(req, { status: "error" }, 500);
  const record = rows?.[0] as { user_id: string; firebase_uid: string } | undefined;

  // Always ask Firebase, even when there is no record, so response timing
  // doesn't reveal whether the email is a migrated account.
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${firebaseKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, returnSecureToken: false }),
  });
  if (!record || !res.ok) return json(req, NO_MATCH);
  const firebase = (await res.json()) as { localId?: string };
  if (firebase.localId !== record.firebase_uid) return json(req, NO_MATCH);

  const { error } = await admin.auth.admin.updateUserById(record.user_id, { password, email_confirm: true });
  if (error) return json(req, { status: "error" }, 500);
  return json(req, { status: "migrated" });
});
