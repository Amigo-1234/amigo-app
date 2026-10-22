/**
 * Read-only production checks: the domain serves the redesigned app, nothing
 * private ships to the browser, and private endpoints refuse anonymous calls.
 *
 *   BASE=https://<domain> VERCEL_BYPASS=… node scripts/test/prod-exposure.test.mjs
 *
 * Creates nothing and changes nothing. Prints no secrets.
 */
const { BASE, VERCEL_BYPASS } = process.env;
if (!BASE || !VERCEL_BYPASS) throw new Error("Set BASE and VERCEL_BYPASS");
const BYPASS = { "x-vercel-protection-bypass": VERCEL_BYPASS };

let failures = 0;
const ok = (label, cond, extra = "") => {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
};
const get = (path, headers = BYPASS, init = {}) => fetch(`${BASE}${path}`, { headers, redirect: "manual", ...init });

// --- the redesigned app is what the domain serves
const home = await get("/");
const html = await home.text();
ok("home page loads", home.status === 200, String(home.status));
ok("serves the redesigned app (offline page and robots.txt exist)", (await get("/offline.html")).status === 200 && (await (await get("/robots.txt")).text()).includes("User-agent"));
ok("index.html is not cached", /no-cache|no-store|max-age=0/.test(home.headers.get("cache-control") ?? ""), home.headers.get("cache-control") ?? "none");
ok("security headers", home.headers.get("x-content-type-options") === "nosniff" && home.headers.get("x-frame-options") === "DENY");
const anonymous = await get("/", {});
console.log(`info production without the bypass answers ${anonymous.status} (${anonymous.status === 200 ? "public" : "behind Vercel Authentication"})`);

// --- nothing private in what the browser downloads
const assets = [...new Set([...html.matchAll(/(?:src|href)="(\/assets\/[^"]+\.(?:js|css))"/g)].map((m) => m[1]))];
const queue = [...assets];
const seen = new Set();
let shipped = html;
while (queue.length && seen.size < 80) {
  const a = queue.shift();
  if (seen.has(a)) continue;
  seen.add(a);
  const body = await (await get(a)).text();
  shipped += body;
  for (const m of body.matchAll(/["'(/]?(assets\/[A-Za-z0-9_.-]+\.js)/g)) queue.push(`/${m[1]}`);
}
ok("found the app's scripts", seen.size > 0, `${seen.size} files`);
const patterns = {
  "R2 credential names": /R2_(SECRET|ACCESS_KEY|ACCOUNT_ID)/,
  "R2 bucket endpoint": /r2\.cloudflarestorage\.com/,
  "signed URL credentials": /X-Amz-Credential=/,
  "database connection strings": /postgres(ql)?:\/\/|neondb_owner/,
  "private keys": /BEGIN [A-Z ]*PRIVATE KEY/,
  "service keys": /service_role|sk_live_/,
  "personal email addresses": /[A-Za-z0-9._%+-]+@(gmail|yahoo|outlook|hotmail|icloud|privaterelay\.appleid)\.com/i,
};
for (const [label, re] of Object.entries(patterns)) ok(`no ${label} in the shipped code`, !re.test(shipped));
const map = await get(`${[...seen][0]}.map`);
const mapBody = await map.text();
ok("no source maps published", !mapBody.trimStart().startsWith('{"version"'), String(map.status));

// --- private endpoints refuse anonymous callers
const upload = await get("/api/media-upload", { ...BYPASS, "content-type": "application/json" }, { method: "POST", body: JSON.stringify({ purpose: "post", mime: "image/jpeg", size: 10 }) });
ok("upload links need sign-in", upload.status === 401, String(upload.status));
const media = await get("/api/media/00000000-0000-0000-0000-000000000000/post/00000000000000000000000000000000.jpg");
ok("media reads need sign-in", media.status === 401, String(media.status));
const rest = await get("/neon/rest/v1/profiles?select=id&limit=1");
const restBody = await rest.text();
// Neon's Data API refuses requests without a sign-in token (400/401/403) and returns no rows.
ok("database refuses anonymous reads", rest.status >= 400 && !restBody.includes('"id"'), String(rest.status));

console.log(failures ? `${failures} FAILED` : "ALL EXPOSURE CHECKS PASSED");
process.exit(failures ? 1 : 0);
