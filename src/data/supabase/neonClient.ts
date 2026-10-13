import { createClient, SupabaseAuthAdapter } from "@neondatabase/neon-js";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./database.types";

/**
 * Neon Auth (Managed Better Auth) + Neon Data API, behind the same
 * Supabase-style API the rest of src/data/supabase uses (.auth, .from, .rpc).
 *
 * Both services are reached through same-origin paths (/neon/auth,
 * /neon/rest/v1) that api/neon.ts proxies to the project's public Neon
 * endpoints. Same-origin keeps the auth session cookie first-party, so
 * sessions survive refreshes even where third-party cookies are blocked
 * (Safari). No database credentials are involved: the browser only ever
 * holds its own session and the short-lived JWT Neon Auth issues for it.
 */
const base = `${location.origin}/neon`;

// Data API calls carry only a Bearer JWT (no cookies), so they can go straight
// to Neon when its CORS allows this origin (VITE_NEON_DATA_API_URL, set for the
// preview): one hop fewer per request, and polling doesn't consume Vercel
// function invocations. Elsewhere they use the same-origin proxy.
const directDataApi = import.meta.env.VITE_NEON_DATA_API_URL as string | undefined;
const directOrigins = ((import.meta.env.VITE_NEON_DATA_API_ORIGINS as string | undefined) ?? "").split(",").map((o) => o.trim());
const dataApiUrl = directDataApi && directOrigins.includes(location.origin) ? directDataApi : `${base}/rest/v1`;

const client = createClient<Database>({
  auth: { adapter: SupabaseAuthAdapter(), url: `${base}/auth` },
  dataApi: { url: dataApiUrl },
});

// The parts used here (.auth, .from, .rpc) are Supabase-compatible; Realtime
// (.channel) and Storage are not available and are never called on Neon.
export const neonClient = client as unknown as SupabaseClient<Database>;

type OtpResult = Promise<{ error?: { message?: string; code?: string } | null }>;
type EmailOtpClient = {
  emailOtp: {
    sendVerificationOtp(args: { email: string; type: "email-verification" | "forget-password" }): OtpResult;
    verifyEmail(args: { email: string; otp: string }): OtpResult;
    resetPassword(args: { email: string; otp: string; password: string }): OtpResult;
  };
};
const betterAuth = () => (client.auth as unknown as { getBetterAuthInstance(): EmailOtpClient }).getBetterAuthInstance();

function check(result: { error?: { message?: string; code?: string } | null } | undefined) {
  if (result?.error) throw Object.assign(new Error(result.error.message || "Request failed"), { code: result.error.code ?? "" });
}

/** Email ownership check by code (the shared Neon email provider sends codes, not links). */
export const neonEmailCodes = {
  async send(email: string) {
    check(await betterAuth().emailOtp.sendVerificationOtp({ email, type: "email-verification" }));
  },
  async verify(email: string, code: string) {
    check(await betterAuth().emailOtp.verifyEmail({ email, otp: code.trim() }));
    // Refresh the cached session so emailVerified (and the JWT) are current.
    await client.auth.getSession({ forceFetch: true } as never);
  },
};

/** Password reset by emailed code (the shared Neon email provider can't send links). */
export const neonPasswordReset = {
  async send(email: string) {
    check(await betterAuth().emailOtp.sendVerificationOtp({ email, type: "forget-password" }));
  },
  async reset(email: string, code: string, password: string) {
    check(await betterAuth().emailOtp.resetPassword({ email, otp: code.trim(), password }));
  },
};

type SignUpClient = {
  signUp: { email(args: { email: string; password: string; name: string }): Promise<{ error?: { message?: string; code?: string; status?: number } | null }> };
};

/** Better Auth sign-up (name becomes the profile's display name via the user-sync trigger). */
export async function neonSignUp(email: string, password: string, name: string) {
  const result = await (betterAuth() as unknown as SignUpClient).signUp.email({ email, password, name });
  if (result?.error) throw Object.assign(new Error(result.error.message || "Sign-up failed"), { code: result.error.code ?? "" });
}
