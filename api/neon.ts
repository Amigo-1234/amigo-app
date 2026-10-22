/**
 * Same-origin proxy to the project's public Neon endpoints (Neon Auth and the
 * Data API), so the auth session cookie is first-party (works where
 * third-party cookies are blocked, e.g. Safari).
 *
 *   /neon/auth/...     -> Neon Auth (Managed Better Auth)
 *   /neon/rest/v1/...  -> Neon Data API
 *
 * A plain vercel.json rewrite can't be used: Vercel's proxy adds
 * X-Forwarded-Host, and Neon Auth rejects any request carrying a forwarded
 * host it doesn't own (400 INVALID_HOSTNAME). This forwards only the
 * end-to-end headers. It holds no credentials: requests carry the browser's
 * own session cookie / JWT, exactly as a direct call would.
 */
export const config = { runtime: "edge" };

const UPSTREAM: Record<string, string> = {
  auth: "https://ep-dry-mode-zano9y8g.neonauth.c-2.eu-west-2.aws.neon.tech/neondb/auth",
  rest: "https://ep-dry-mode-zano9y8g.apirest.c-2.eu-west-2.aws.neon.tech/neondb/rest",
};

// Hop-by-hop, proxy-added and platform headers are not forwarded upstream.
const DROP_REQUEST = /^(host|connection|keep-alive|transfer-encoding|upgrade|content-length|accept-encoding|forwarded|via|x-forwarded-.*|x-real-ip|x-vercel-.*|cf-.*|true-client-ip)$/i;
// fetch() already decoded the body, so length/encoding headers no longer apply.
const DROP_RESPONSE = /^(connection|keep-alive|transfer-encoding|content-length|content-encoding|set-cookie)$/i;

export default async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.searchParams.get("path") ?? "";
  url.searchParams.delete("path");
  const [service, ...rest] = path.split("/");
  const base = UPSTREAM[service];
  if (!base || rest.some((s) => s === ".." || s === ".")) return new Response("Not found", { status: 404 });

  const target = `${base}/${rest.map(encodeURIComponent).join("/")}${url.search}`;
  const headers = new Headers();
  req.headers.forEach((value, key) => {
    if (!DROP_REQUEST.test(key)) headers.set(key, value);
  });

  const upstream = await fetch(target, {
    method: req.method,
    headers,
    body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer(),
    redirect: "manual",
  });

  const out = new Headers();
  upstream.headers.forEach((value, key) => {
    if (!DROP_RESPONSE.test(key)) out.set(key, value);
  });
  // Keep cookies host-only on this site: drop any Domain attribute.
  for (const cookie of upstream.headers.getSetCookie()) out.append("set-cookie", cookie.replace(/;\s*domain=[^;]*/gi, ""));

  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: out });
}
