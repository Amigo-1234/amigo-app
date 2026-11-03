/**
 * Username reservations: the only server route of the amigo-reserve project
 * (reserve.amigoworld.com.ng), separate from the main Amigo World app.
 *
 *   GET  /api/reserve                     → { open, holdDays, turnstileSiteKey }
 *   POST /api/reserve { action: "check",  username }               → { username, status }
 *   POST /api/reserve { action: "start",  username, email, adult: true, token? } → { id }   (a code is emailed)
 *   POST /api/reserve { action: "verify", id, code }               → { username, expiresAt }
 *
 * - It talks to the database as the login-less role username_reserver (given a
 *   login by an operator), which can run reserve_check / reserve_start /
 *   reserve_verify and nothing else. No Amigo account is made or touched.
 * - Codes are 6 random digits made here; the database only ever sees their SHA-256.
 * - "start" answers the browser the same way whatever happens (code sent, name
 *   already yours, too many names): only the email's owner is told which. So the
 *   page can't be used to learn which email holds which name.
 * - IPs are only used as a salted hash, for the limits in the database.
 * - Browsers from other sites are refused (Origin must be one of ours).
 * - With TURNSTILE_SECRET set, "start" also needs a Cloudflare Turnstile token.
 *
 * Environment: RESERVE_DATABASE_URL, RESERVE_PEPPER (random, 32+ chars), RESEND_API_KEY,
 * EMAIL_FROM; optional EMAIL_REPLY_TO, TURNSTILE_SECRET, TURNSTILE_SITE_KEY,
 * RESERVE_ORIGINS (extra allowed origins, comma-separated). For tests only:
 * RESERVE_SQL_URL_OVERRIDE, RESERVE_EMAIL_URL_OVERRIDE.
 */
import { alreadyYoursEmail, codeEmail, confirmedEmail, limitEmail, type ReserveEmail } from "./_reserveEmail";

export const config = { runtime: "edge" };

const ENV = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const ORIGINS = ["https://reserve.amigoworld.com.ng"];

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const log = (outcome: string, extra: Record<string, unknown> = {}) => console.log(JSON.stringify({ at: "reserve", outcome, ...extra }));

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Six digits, evenly spread (no modulo bias). */
function newCode(): string {
  const max = Math.floor(0x1_0000_0000 / 1_000_000) * 1_000_000;
  const n = new Uint32Array(1);
  do crypto.getRandomValues(n);
  while (n[0] >= max);
  return String(n[0] % 1_000_000).padStart(6, "0");
}

/** One statement over Neon's HTTP endpoint, as the role in `conn`; returns the one text column `r`. */
async function call(conn: string, query: string, params: unknown[]): Promise<Record<string, unknown>> {
  const endpoint = ENV.RESERVE_SQL_URL_OVERRIDE ?? `https://${new URL(conn).hostname.replace(/^[^.]+\./, "api.")}/sql`;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", "neon-connection-string": conn },
    body: JSON.stringify({ query, params }),
  });
  const body = (await res.json().catch(() => null)) as { rows?: { r: string }[]; code?: string } | null;
  // Status and Postgres code only: the error text could echo connection details.
  if (!res.ok || !body?.rows?.[0]) throw new Error(`database ${res.status} ${body?.code ?? ""}`.trim());
  return JSON.parse(body.rows[0].r) as Record<string, unknown>;
}

async function send(to: string, email: ReserveEmail, idempotencyKey: string): Promise<boolean> {
  const res = await fetch(ENV.RESERVE_EMAIL_URL_OVERRIDE ?? "https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${ENV.RESEND_API_KEY}`, "content-type": "application/json", "idempotency-key": idempotencyKey },
    body: JSON.stringify({
      from: ENV.EMAIL_FROM,
      to: [to],
      subject: email.subject,
      html: email.html,
      text: email.text,
      ...(ENV.EMAIL_REPLY_TO ? { reply_to: ENV.EMAIL_REPLY_TO } : {}),
      tags: [{ name: "kind", value: "reservation" }],
    }),
  }).catch(() => null);
  return !!res?.ok;
}

async function turnstileOk(token: unknown, ip: string): Promise<boolean> {
  if (!ENV.TURNSTILE_SECRET) return true;
  if (typeof token !== "string" || !token || token.length > 4096) return false;
  const form = new FormData();
  form.set("secret", ENV.TURNSTILE_SECRET);
  form.set("response", token);
  if (ip) form.set("remoteip", ip);
  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form }).catch(() => null);
  const body = (await res?.json().catch(() => null)) as { success?: boolean } | null;
  return body?.success === true;
}

// What the page shows for each refusal. Statuses tell the page whether to let the person try again.
const ERRORS: Record<string, [number, string]> = {
  slow_down: [429, "Too many tries. Please wait a little and try again."],
  closed: [403, "Reservations aren't open right now."],
  invalid_name: [400, "Usernames are 3–24 characters: letters, numbers and underscores."],
  invalid_email: [400, "Enter a valid email address."],
  unavailable: [409, "That username isn't available."],
  wait: [429, "We just sent a code. Wait a minute before asking for another."],
  expired: [410, "That code has expired. Ask for a new one."],
  wrong_code: [400, "That code isn't right."],
  taken: [409, "Someone registered that username while your code was on its way."],
};
const refuse = (key: string, extra: Record<string, unknown> = {}) => {
  const [status, message] = ERRORS[key] ?? [400, "Something went wrong."];
  return json(status, { error: key, message, ...extra });
};

export default async function handler(req: Request): Promise<Response> {
  const conn = ENV.RESERVE_DATABASE_URL;
  const pepper = ENV.RESERVE_PEPPER;
  if (!conn || !pepper || pepper.length < 32 || !ENV.RESEND_API_KEY || !ENV.EMAIL_FROM) return json(503, { error: "not-configured", message: "Reservations aren't available right now." });

  const origin = req.headers.get("origin");
  const allowed = [...ORIGINS, ...(ENV.RESERVE_ORIGINS ?? "").split(",").map((o) => o.trim()).filter(Boolean)];
  if (origin && !allowed.includes(origin)) return json(403, { error: "origin" });

  const ip = (req.headers.get("x-real-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0] ?? "").trim();
  const ipHash = await sha256(`${pepper}|ip|${ip || "unknown"}`);

  try {
    if (req.method === "GET") {
      const r = await call(conn, "select public.reserve_check($1, $2)::text as r", ["", ipHash]);
      return json(200, { open: r.open === true, holdDays: r.hold_days, turnstileSiteKey: ENV.TURNSTILE_SECRET ? (ENV.TURNSTILE_SITE_KEY ?? null) : null });
    }
    if (req.method !== "POST") return json(405, { error: "method" });
    // A form post from another site would carry an Origin; a missing one must at least be JSON.
    if (!origin && !(req.headers.get("content-type") ?? "").startsWith("application/json")) return json(415, { error: "type" });
    const raw = await req.text();
    if (raw.length > 4000) return json(413, { error: "too-large" });
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return json(400, { error: "body" });
    }
    const str = (k: string, max: number) => (typeof body[k] === "string" ? (body[k] as string).trim().slice(0, max) : "");

    if (body.action === "check") {
      const r = await call(conn, "select public.reserve_check($1, $2)::text as r", [str("username", 40), ipHash]);
      if (typeof r.error === "string") return refuse(r.error);
      return json(200, { username: r.username, status: r.status, open: r.open === true });
    }

    if (body.action === "start") {
      // Amigo is for adults; the person confirms it on the page (no ID is asked for).
      if (body.adult !== true) return json(400, { error: "age", message: "Amigo World is for people 18 or older." });
      if (!(await turnstileOk(body.token, ip))) return json(400, { error: "challenge", message: "Please complete the check and try again." });
      const code = newCode();
      const r = await call(conn, "select public.reserve_start($1, $2, $3, $4)::text as r", [str("username", 40), str("email", 254), await sha256(code), ipHash]);
      if (typeof r.error === "string") return refuse(r.error);
      const to = String(r.email);
      const username = String(r.username);
      if (r.action === "code") {
        const ok = await send(to, codeEmail(username, code, r.renewal === true), `reserve-code-${r.id}-${await sha256(code)}`);
        if (!ok) {
          log("send-failed", { kind: "code" });
          return json(502, { error: "send-failed", message: "We couldn't send the email. Wait a minute and try again." });
        }
        log("code-sent", { renewal: r.renewal === true });
        return json(200, { id: r.id });
      }
      // Told by email only; the browser sees the same answer as a sent code.
      const email = r.action === "notice_active" ? alreadyYoursEmail(username, String(r.expires_at)) : limitEmail(username, (r.held as string[]) ?? []);
      if (!(await send(to, email, `reserve-${r.action}-${await sha256(`${to}|${username}|${new Date().toISOString().slice(0, 13)}`)}`))) log("send-failed", { kind: r.action });
      log("notice-sent", { kind: r.action });
      return json(200, { id: crypto.randomUUID() });
    }

    if (body.action === "verify") {
      const id = str("id", 40);
      const code = str("code", 12).replace(/\D/g, "");
      if (!/^[0-9a-f-]{36}$/.test(id) || code.length !== 6) return refuse("wrong_code");
      const r = await call(conn, "select public.reserve_verify($1::uuid, $2, $3)::text as r", [id, await sha256(code), ipHash]);
      if (typeof r.error === "string") return refuse(r.error, typeof r.tries_left === "number" ? { triesLeft: r.tries_left } : {});
      // The reservation stands even if the confirmation can't be sent.
      if (!(await send(String(r.email), confirmedEmail(String(r.username), String(r.expires_at)), `reserve-confirmed-${id}-${String(r.expires_at)}`))) log("send-failed", { kind: "confirmed" });
      log("verified");
      return json(200, { username: r.username, expiresAt: r.expires_at });
    }
    return json(400, { error: "action" });
  } catch (e) {
    log("failed", { reason: e instanceof Error ? e.message : "error" });
    return json(502, { error: "unavailable", message: "Something went wrong on our side. Please try again." });
  }
}
