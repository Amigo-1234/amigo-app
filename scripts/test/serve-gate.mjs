/**
 * Local check of the access gate in a browser: serves a built app (default dist/) on
 * 127.0.0.1:5175 with middleware.ts in front, as Vercel would run it. Not used by any build.
 *
 *   MAINTENANCE_MODE=on MAINTENANCE_ACCESS_KEY=<test key> node scripts/test/serve-gate.mjs [dir]
 */
import { createServer as createHttp } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { createServer } from "vite";

const root = resolve(process.argv[2] ?? "dist");
const publicDir = resolve("public");
const vite = await createServer({ logLevel: "error", server: { middlewareMode: true }, appType: "custom" });
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png", ".ico": "image/x-icon" };

async function file(path) {
  for (const dir of [root, publicDir]) {
    const p = join(dir, path);
    if (!p.startsWith(dir)) return null;
    if ((await stat(p).catch(() => null))?.isFile()) return p;
  }
  return null;
}

createHttp(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const request = new Request(`http://${req.headers.host}${req.url}`, {
    method: req.method,
    headers: Object.entries(req.headers).filter(([, v]) => typeof v === "string"),
    body: req.method === "GET" || req.method === "HEAD" ? undefined : Buffer.concat(chunks),
  });
  const { default: gate } = await vite.ssrLoadModule("/middleware.ts");
  const answer = await gate(request);
  if (answer) {
    res.statusCode = answer.status;
    answer.headers.forEach((v, k) => res.setHeader(k, v));
    return res.end(Buffer.from(await answer.arrayBuffer()));
  }
  const path = decodeURIComponent(new URL(request.url).pathname);
  if (path.startsWith("/api/") || path.startsWith("/neon/")) {
    res.statusCode = 404;
    return res.end(JSON.stringify({ error: "no backend in this local check" }));
  }
  const found = (path !== "/" && (await file(path))) || join(root, "index.html");
  res.setHeader("content-type", TYPES[extname(found)] ?? "application/octet-stream");
  res.end(await readFile(found));
}).listen(5175, "127.0.0.1", () => console.log(`gate check on http://127.0.0.1:5175 (serving ${root})`));
