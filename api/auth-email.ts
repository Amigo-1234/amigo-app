/**
 * POST /api/auth-email — Neon Auth (Managed Better Auth) webhook for the
 * send.otp and send.magic_link events: delivers the code / link Neon Auth made
 * as a branded Amigo World email through Resend. When the webhook is enabled
 * for these events Neon skips its own email, so this is the only delivery.
 *
 * - Every request is checked: Ed25519 detached-JWS signature against Neon
 *   Auth's JWKS (key looked up by kid), and a timestamp no older than 5
 *   minutes. Anything else gets 401 and nothing is sent.
 * - Duplicates (Neon retries with the same event id): skipped here if seen
 *   recently, and Resend's Idempotency-Key (the event id) drops any that slip
 *   through on another instance.
 * - Codes, links, tokens and payloads are never logged; logs carry the event
 *   type and outcome only.
 * - A provider failure answers 502, so Neon retries (3 attempts within 15 s);
 *   if all fail the person sees an error in the app and can ask for a new code.
 *
 * Environment: RESEND_API_KEY, EMAIL_FROM ("Amigo World <no-reply@amigoworld.com.ng>"),
 * optional EMAIL_REPLY_TO and NEON_AUTH_URL (defaults to this project's auth URL).
 */
import { codeEmail, isKind, linkEmail, validMinutes } from "./_authEmail";

export const config = { runtime: "edge" };

const ENV = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const DEFAULT_AUTH_URL = "https://ep-dry-mode-zano9y8g.neonauth.c-2.eu-west-2.aws.neon.tech/neondb/auth";
const MAX_AGE_MS = 5 * 60_000;

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const log = (outcome: string, extra: Record<string, unknown> = {}) => console.log(JSON.stringify({ at: "auth-email", outcome, ...extra }));

// ------------------------------------------------------------ signature
type Jwk = JsonWebKey & { kid?: string };
let jwks: { keys: Jwk[]; at: number } | null = null;
let lastRefresh = 0;

async function keyFor(kid: string, authUrl: string): Promise<CryptoKey | null> {
  const find = () => jwks?.keys.find((k) => k.kid === kid);
  // Unknown key (first use or rotation): refetch, at most every 30 s.
  if (!find() && Date.now() - lastRefresh > 30_000) {
    lastRefresh = Date.now();
    const res = await fetch(`${authUrl}/.well-known/jwks.json`);
    if (res.ok) jwks = { keys: ((await res.json()) as { keys?: Jwk[] }).keys ?? [], at: Date.now() };
  }
  const jwk = find();
  if (!jwk) return null;
  const { kty, crv, x } = jwk;
  return crypto.subtle.importKey("jwk", { kty, crv, x }, { name: "Ed25519" }, false, ["verify"]);
}

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const utf8 = (s: string) => new TextEncoder().encode(s);

/** Neon's scheme: detached JWS over base64url(timestamp + "." + base64url(rawBody)). */
export async function verifyNeonSignature(raw: string, headers: Headers, authUrl: string, now = Date.now()): Promise<boolean> {
  const signature = headers.get("x-neon-signature");
  const kid = headers.get("x-neon-signature-kid");
  const timestamp = headers.get("x-neon-timestamp");
  if (!signature || !kid || !timestamp || !/^\d{10,16}$/.test(timestamp)) return false;
  const age = now - Number(timestamp);
  if (age > MAX_AGE_MS || age < -MAX_AGE_MS) return false;
  const [header, empty, sig, ...rest] = signature.split(".");
  if (!header || empty !== "" || !sig || rest.length) return false;
  const key = await keyFor(kid, authUrl).catch(() => null);
  if (!key) return false;
  const signingInput = `${header}.${b64url(utf8(`${timestamp}.${b64url(utf8(raw))}`))}`;
  try {
    return await crypto.subtle.verify({ name: "Ed25519" }, key, fromB64url(sig), utf8(signingInput));
  } catch {
    return false;
  }
}

// ------------------------------------------------------------ duplicates
const seen = new Map<string, number>();
const DUP_MS = 15 * 60_000;
function firstTime(id: string): boolean {
  const now = Date.now();
  for (const [k, t] of seen) if (now - t > DUP_MS) seen.delete(k);
  if (seen.has(id)) return false;
  seen.set(id, now);
  return true;
}

// ------------------------------------------------------------ handler
type Payload = {
  event_id?: string;
  event_type?: string;
  timestamp?: string;
  user?: { email?: string };
  event_data?: { otp_code?: string; otp_type?: string; link_type?: string; link_url?: string; expires_at?: string; delivery_preference?: string };
};

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== "POST") return json(405, { error: "method" });
  const { RESEND_API_KEY, EMAIL_FROM, EMAIL_REPLY_TO } = ENV;
  const authUrl = (ENV.NEON_AUTH_URL || DEFAULT_AUTH_URL).replace(/\/+$/, "");
  const raw = await req.text();
  if (raw.length > 64_000) return json(413, { error: "too-large" });
  if (!(await verifyNeonSignature(raw, req.headers, authUrl))) {
    log("rejected-signature");
    return json(401, { error: "signature" });
  }
  let event: Payload;
  try {
    event = JSON.parse(raw) as Payload;
  } catch {
    return json(400, { error: "body" });
  }
  const type = event.event_type;
  if (type !== "send.otp" && type !== "send.magic_link") return json(200, { ignored: true });
  if (!RESEND_API_KEY || !EMAIL_FROM) {
    log("not-configured", { type });
    return json(503, { error: "email-not-configured" });
  }
  const id = event.event_id ?? req.headers.get("x-neon-event-id") ?? "";
  const to = event.user?.email ?? "";
  const data = event.event_data ?? {};
  if (!id || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return json(400, { error: "payload" });
  if (data.delivery_preference === "sms") return json(200, { ignored: "sms" });

  const minutes = validMinutes(data.expires_at, event.timestamp);
  let email;
  if (type === "send.otp") {
    if (!isKind(data.otp_type) || !/^\d{4,10}$/.test(data.otp_code ?? "")) return json(400, { error: "payload" });
    email = codeEmail(data.otp_type, data.otp_code!, minutes);
  } else {
    const url = data.link_url ?? "";
    if (!isKind(data.link_type) || !/^https:\/\//.test(url)) return json(400, { error: "payload" });
    email = linkEmail(data.link_type, url, minutes);
  }
  const kind = type === "send.otp" ? data.otp_type : data.link_type;
  if (!firstTime(id)) {
    log("duplicate", { type, kind });
    return json(200, { duplicate: true });
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${RESEND_API_KEY}`, "content-type": "application/json", "idempotency-key": `neon-${id}` },
    body: JSON.stringify({
      from: EMAIL_FROM,
      to: [to],
      subject: email.subject,
      html: email.html,
      text: email.text,
      ...(EMAIL_REPLY_TO ? { reply_to: EMAIL_REPLY_TO } : {}),
      tags: [{ name: "kind", value: String(kind).replace(/[^a-zA-Z0-9_-]/g, "_") }],
    }),
  }).catch(() => null);
  if (!res?.ok) {
    seen.delete(id); // let Neon's retry try again
    log("send-failed", { type, kind, status: res?.status ?? 0 });
    return json(502, { error: "send-failed" });
  }
  log("sent", { type, kind });
  return json(200, { sent: true });
}
