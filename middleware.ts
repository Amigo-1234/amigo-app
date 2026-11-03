/**
 * Access gate (Vercel Routing Middleware): while MAINTENANCE_MODE is "on", the site is closed to
 * the public. It runs on Vercel before static files, rewrites and functions, so nothing of the app
 * — pages, scripts, sign-in, sign-up, the /neon proxy, the api/ routes — reaches anyone without
 * team access. They get the "under development" page (503), or a 503 JSON answer for APIs.
 *
 *   MAINTENANCE_MODE        "on" closes the site. Anything else (or unset): no effect at all.
 *   MAINTENANCE_ACCESS_KEY  The team key (at least 24 characters). Entered once at /_team, it
 *                           gives that browser a signed, HttpOnly cookie for 30 days. Changing the
 *                           key signs every browser out of team access. Unset: nobody gets in.
 *
 * Always open, because other servers call them and they check their own credentials:
 *   /api/auth-email     Neon Auth's email webhook (signed)
 *   /api/media-cleanup  the daily Vercel Cron job (CRON_SECRET)
 *
 * Only this project (amigoworld.com.ng) has the gate. The reservation site is a separate Vercel
 * project rooted at reserve/, so this file isn't part of it.
 */
import { teamAccessHtml, UNDER_DEVELOPMENT_HTML } from "./gate/pages";

const COOKIE = "amigo_team_access";
const ACCESS_DAYS = 30;
const MIN_KEY_LENGTH = 24;

/** Server-to-server routes, exact paths. */
const SERVER_ROUTES = new Set(["/api/auth-email", "/api/media-cleanup"]);
/** What the gate pages themselves load. */
const PAGE_FILES = (path: string) => path.startsWith("/_maintenance/") || path === "/favicon.svg" || path === "/favicon.ico";

const enc = new TextEncoder();

function b64url(bytes: ArrayBuffer): string {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmac(key: string, message: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", k, enc.encode(message)));
}

/** Compares two strings without leaking where they differ (both hashed first, so lengths match). */
async function same(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
  const p = new Uint8Array(x);
  const q = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < p.length; i++) diff |= p[i] ^ q[i];
  return diff === 0;
}

const accessKey = () => {
  const k = process.env.MAINTENANCE_ACCESS_KEY ?? "";
  return k.length >= MIN_KEY_LENGTH ? k : null;
};

async function makeToken(key: string): Promise<string> {
  const expires = Math.floor(Date.now() / 1000) + ACCESS_DAYS * 86400;
  return `v1.${expires}.${await hmac(key, `amigo-team-access|v1|${expires}`)}`;
}

async function hasAccess(request: Request): Promise<boolean> {
  const key = accessKey();
  if (!key) return false;
  const token = (request.headers.get("cookie") ?? "")
    .split(/;\s*/)
    .find((c) => c.startsWith(`${COOKIE}=`))
    ?.slice(COOKIE.length + 1);
  const m = token ? /^v1\.(\d{1,12})\.([A-Za-z0-9_-]{43})$/.exec(token) : null;
  if (!m || Number(m[1]) * 1000 < Date.now()) return false;
  return same(m[2], await hmac(key, `amigo-team-access|v1|${m[1]}`));
}

const NO_STORE = { "cache-control": "no-store", "x-robots-tag": "noindex" };

function html(body: string, status: number, extra: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", ...NO_STORE, ...extra } });
}

const cookie = (value: string, maxAge: number) => `${COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;

async function team(request: Request, path: string): Promise<Response> {
  if (path === "/_team/leave") {
    if (request.method !== "POST") return html(teamAccessHtml(), 200);
    return new Response(null, { status: 303, headers: { location: "/", "set-cookie": cookie("", 0), ...NO_STORE } });
  }
  if (request.method === "POST") {
    const key = accessKey();
    const form = await request.formData().catch(() => null);
    const given = form?.get("key");
    if (!key || typeof given !== "string" || !(await same(given, key))) {
      return html(teamAccessHtml({ error: "That key isn't right." }), 403);
    }
    return new Response(null, { status: 303, headers: { location: "/", "set-cookie": cookie(await makeToken(key), ACCESS_DAYS * 86400), ...NO_STORE } });
  }
  return html(teamAccessHtml({ signedIn: await hasAccess(request) }), 200);
}

export default async function middleware(request: Request): Promise<Response | undefined> {
  if (process.env.MAINTENANCE_MODE !== "on") return;

  const path = new URL(request.url).pathname;
  if (SERVER_ROUTES.has(path) || PAGE_FILES(path)) return;
  if (path === "/_team" || path === "/_team/leave") return team(request, path);
  if (await hasAccess(request)) return;

  if (path.startsWith("/api/") || path === "/api" || path.startsWith("/neon/") || path === "/neon") {
    return new Response(JSON.stringify({ error: "unavailable", message: "Amigo World isn't publicly available yet." }), {
      status: 503,
      headers: { "content-type": "application/json", "retry-after": "3600", ...NO_STORE },
    });
  }
  return html(request.method === "HEAD" ? "" : UNDER_DEVELOPMENT_HTML, 503, { "retry-after": "3600" });
}
