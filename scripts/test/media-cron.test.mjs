/**
 * The daily clean-up (api/media-cleanup.ts), offline, against a stand-in database and bucket:
 *
 *   - only a request carrying "Bearer <CRON_SECRET>" gets in (missing, wrong, prefixed or
 *     padded values get 401); without CRON_SECRET, the database link or the bucket it does
 *     nothing (503); only GET (what Vercel Cron sends);
 *   - it first releases what's due, then leases, deletes and confirms in batches of 20,
 *     confirming only files really gone (deleted, or already missing); a failed delete is not
 *     confirmed (it comes back after its lease);
 *   - it stops when the queue is drained, and answers counts only;
 *   - a database failure answers 502 without the connection details, in the response or the log;
 *   - the SQL goes to Neon's HTTP endpoint for the host in CLEANUP_DATABASE_URL, as that role.
 *
 *   node scripts/test/media-cron.test.mjs
 */
import { createServer } from "vite";

let failures = 0;
const ok = (label, cond, extra = "") => {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
};

const CRON = "test-cron-secret-0123456789";
const CONN = "postgresql://media_janitor:conn-password-should-never-leak@ep-test-123.c-2.eu-west-2.aws.neon.tech/neondb?sslmode=require";
Object.assign(process.env, {
  CRON_SECRET: CRON,
  CLEANUP_DATABASE_URL: CONN,
  R2_ACCOUNT_ID: "acct",
  R2_ACCESS_KEY_ID: "test-access-key",
  R2_SECRET_ACCESS_KEY: "test-secret-key",
  R2_BUCKET: "bucket",
  R2_ENDPOINT_OVERRIDE: "https://r2.test/bucket",
});
const vite = await createServer({ server: { middlewareMode: true }, appType: "custom", logLevel: "error" });
const cleanup = (await vite.ssrLoadModule("/api/media-cleanup.ts")).default;

// ------------------------------------------------------------ stand-ins
let calls = [];
let batches = [];
let deleteStatus = {};
let dbDown = false;
globalThis.fetch = async (input, init = {}) => {
  const req = input instanceof Request ? input : new Request(input, init);
  const body = req.method === "POST" ? await req.clone().json().catch(() => null) : null;
  calls.push({ url: req.url, method: req.method, body, conn: req.headers.get("neon-connection-string") });
  if (req.url.startsWith("https://r2.test/")) {
    const key = decodeURIComponent(new URL(req.url).pathname.replace("/bucket/", ""));
    return new Response(null, { status: deleteStatus[key] ?? 204 });
  }
  if (req.url.endsWith("/sql")) {
    if (dbDown) return Response.json({ message: `password authentication failed for ${CONN}`, code: "28P01" }, { status: 400 });
    const q = body.query;
    if (q.includes("media_janitor_release")) return Response.json({ rows: [{ released: { takedown: 1, stale: 2 } }] });
    if (q.includes("media_janitor_take")) return Response.json({ rows: batches.shift() ?? [] });
    if (q.includes("media_janitor_done")) return Response.json({ rows: [{ n: JSON.parse(body.params[0]).length }] });
  }
  return Response.json({ message: `unexpected ${req.url}` }, { status: 500 });
};
const logs = [];
const origLog = console.log, origWarn = console.warn;
const capture = (fn) => (...a) => { logs.push(a.join(" ")); if (!String(a[0]).startsWith("{")) fn(...a); };
console.log = capture(origLog);
console.warn = capture(origWarn);

const run = (headers = { authorization: `Bearer ${CRON}` }, method = "GET") =>
  cleanup(new Request("https://app.test/api/media-cleanup", { method, headers })).then(async (r) => ({ status: r.status, body: await r.json() }));
const item = (n) => ({ item_id: String(n), item_path: `u/post/f${n}.jpg`, claim: `c${n}` });
const sqlCalls = () => calls.filter((c) => c.url.endsWith("/sql"));

try {
  // ---- who gets in
  for (const [label, headers] of [
    ["no Authorization header", {}],
    ["a wrong secret", { authorization: "Bearer not-the-secret" }],
    ["the secret without Bearer", { authorization: CRON }],
    ["the secret with an extra character", { authorization: `Bearer ${CRON}x` }],
    ["a different scheme", { authorization: `Basic ${CRON}` }],
  ]) {
    calls = [];
    const r = await run(headers);
    ok(`refused: ${label} (401, nothing touched)`, r.status === 401 && calls.length === 0, `${r.status} ${calls.length}`);
  }
  calls = [];
  ok("POST is refused (405)", (await run(undefined, "POST")).status === 405 && calls.length === 0);
  for (const name of ["CRON_SECRET", "CLEANUP_DATABASE_URL", "R2_BUCKET"]) {
    const saved = process.env[name];
    delete process.env[name];
    calls = [];
    const r = await run();
    ok(`without ${name}: 503 and nothing touched`, r.status === 503 && calls.length === 0, `${r.status}`);
    process.env[name] = saved;
  }

  // ---- a run
  calls = [];
  batches = [[item(1), item(2), item(3)]];
  deleteStatus = { "u/post/f1.jpg": 204, "u/post/f2.jpg": 404, "u/post/f3.jpg": 500 };
  const r1 = await run();
  const sql1 = sqlCalls();
  ok("releases what's due first", sql1[0]?.body.query.includes("media_janitor_release"));
  ok("…then leases a batch of 20", sql1[1]?.body.query.includes("media_janitor_take") && sql1[1]?.body.params[0] === 20);
  ok("deletes each leased file from the bucket", calls.filter((c) => c.method === "DELETE").length === 3);
  const done = JSON.parse(sql1.find((c) => c.body.query.includes("media_janitor_done"))?.body.params[0] ?? "[]");
  ok("confirms only files that are gone (deleted or already missing)", JSON.stringify(done) === JSON.stringify([{ id: 1, claim: "c1" }, { id: 2, claim: "c2" }]), JSON.stringify(done));
  ok("the failed delete is not confirmed (it comes back after its lease)", !done.some((d) => d.id === 3));
  ok("stops when a batch comes back short (one take)", sql1.filter((c) => c.body.query.includes("media_janitor_take")).length === 1);
  ok("answers counts only", r1.status === 200 && JSON.stringify(r1.body) === JSON.stringify({ released: { takedown: 1, stale: 2 }, deleted: 2, failed: 1 }), JSON.stringify(r1.body));
  ok("SQL goes to Neon's HTTP endpoint for that host, as that role",
    sql1.every((c) => c.url === "https://api.c-2.eu-west-2.aws.neon.tech/sql" && c.conn === CONN), sql1[0]?.url);

  calls = [];
  batches = [Array.from({ length: 20 }, (_, i) => item(100 + i)), [item(200)]];
  deleteStatus = {};
  const r2 = await run();
  ok("keeps going while batches are full (two takes, 21 deleted)", sqlCalls().filter((c) => c.body.query.includes("media_janitor_take")).length === 2 && r2.body.deleted === 21, JSON.stringify(r2.body));

  calls = [];
  batches = [];
  const r3 = await run();
  ok("an empty queue: release, one take, nothing deleted", r3.status === 200 && r3.body.deleted === 0 && calls.filter((c) => c.method === "DELETE").length === 0);

  // ---- failure
  logs.length = 0;
  dbDown = true;
  const r4 = await run();
  dbDown = false;
  ok("a database failure answers 502", r4.status === 502 && r4.body.error === "cleanup-failed", JSON.stringify(r4.body));
  ok("…without connection details in the response", !JSON.stringify(r4.body).includes("conn-password") && !JSON.stringify(r4.body).includes("postgresql://"));
  ok("…or in the log", logs.length > 0 && logs.every((l) => !l.includes("conn-password") && !l.includes("postgresql://")), logs.join(" | ").slice(0, 200));
  ok("no log line ever carries a path or the secrets", logs.concat(JSON.stringify(r1.body)).every((l) => !l.includes("u/post/") && !l.includes(CRON)));
} catch (e) {
  failures++;
  origLog(`FAIL ${e?.stack ?? e}`);
} finally {
  console.log = origLog;
  console.warn = origWarn;
  await vite.close();
}
console.log(failures ? `${failures} FAILURE(S)` : "ALL MEDIA CRON TESTS PASSED");
process.exit(failures ? 1 : 0);
