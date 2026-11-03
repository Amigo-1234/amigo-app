/**
 * What "Continue with Google" would do on a deployed environment, without
 * signing anyone in: asks the auth service (through the app's /neon/auth
 * proxy, as the button does) for the Google sign-in address, and prints where
 * Google would send the person back to. Prints no secrets or state values.
 *
 *   BASE=https://<domain> VERCEL_BYPASS=… node scripts/test/live-oauth-probe.mjs
 */
const { BASE, VERCEL_BYPASS } = process.env;
if (!BASE || !VERCEL_BYPASS) throw new Error("Set BASE and VERCEL_BYPASS");
const res = await fetch(`${BASE}/neon/auth/sign-in/social`, {
  method: "POST",
  headers: { "x-vercel-protection-bypass": VERCEL_BYPASS, origin: BASE, "content-type": "application/json" },
  body: JSON.stringify({ provider: "google", callbackURL: `${BASE}/`, disableRedirect: true }),
  redirect: "manual",
});
const text = await res.text();
console.log(`status ${res.status}`);
let url = null;
try {
  url = JSON.parse(text).url ?? null;
} catch {
  console.log(`body: ${text.slice(0, 200)}`);
}
if (url) {
  const u = new URL(url);
  console.log(`google host: ${u.host}`);
  console.log(`redirect_uri: ${u.searchParams.get("redirect_uri")}`);
  console.log(`client: ${u.searchParams.get("client_id")?.split("-")[0] ?? "?"}… (prefix only)`);
  console.log(`scopes: ${u.searchParams.get("scope")}`);
}
const cookies = res.headers.getSetCookie?.() ?? [];
console.log(`sets cookies: ${cookies.map((c) => c.split("=")[0]).join(", ") || "none"}`);
