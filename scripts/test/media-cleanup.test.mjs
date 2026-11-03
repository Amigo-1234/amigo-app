/**
 * The upload function's housekeeping (api/media-upload.ts), offline: it leases queued files,
 * deletes them from storage, and confirms to Postgres only the ones that are really gone
 * (deleted now, or already missing). A failed delete stays queued for a retry. Without the
 * server secret it doesn't touch the queue at all.
 *
 *   node scripts/test/media-cleanup.test.mjs
 */
import { createServer } from "vite";

let failures = 0;
const ok = (label, cond, extra = "") => {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
};
Object.assign(process.env, {
  NEON_REST_URL_OVERRIDE: "https://rest.test/rest/v1",
  NEON_AUTH_URL_OVERRIDE: "https://auth.test/neondb/auth",
  R2_ACCOUNT_ID: "acct",
  R2_ACCESS_KEY_ID: "test-access-key",
  R2_SECRET_ACCESS_KEY: "test-secret-key",
  R2_BUCKET: "bucket",
  R2_ENDPOINT_OVERRIDE: "https://r2.test/bucket",
});
const vite = await createServer({ server: { middlewareMode: true }, appType: "custom", logLevel: "error" });
const upload = (await vite.ssrLoadModule("/api/media-upload.ts")).default;

let calls = [];
const deleteStatus = { "q/one": 204, "q/two": 404, "q/three": 500 };
globalThis.fetch = async (input, init = {}) => {
  const req = input instanceof Request ? input : new Request(input, init);
  const u = req.url;
  const body = req.method === "POST" ? await req.clone().json().catch(() => null) : null;
  calls.push({ u, method: req.method, body });
  if (u.endsWith("/rpc/media_begin_upload")) return Response.json("00000000-0000-0000-0000-00000000000a/post/0123456789abcdef0123456789abcdef.jpg");
  if (u.endsWith("/rpc/media_cleanup_take"))
    return Response.json([
      { item_id: 1, item_path: "q/one", claim: "c1" },
      { item_id: 2, item_path: "q/two", claim: "c2" },
      { item_id: 3, item_path: "q/three", claim: "c3" },
    ]);
  if (u.endsWith("/rpc/media_cleanup_done")) return Response.json(body.p_items.length);
  if (u.startsWith("https://r2.test/bucket/") && req.method === "DELETE") return new Response(null, { status: deleteStatus[u.replace("https://r2.test/bucket/", "")] ?? 500 });
  return new Response("unexpected", { status: 500 });
};
const call = () =>
  upload(new Request("https://app.test/api/media-upload", {
    method: "POST",
    headers: { authorization: "Bearer T", "content-type": "application/json" },
    body: JSON.stringify({ purpose: "post", mime: "image/jpeg", size: 1000 }),
  }));

process.env.PUSH_SERVER_SECRET = "cleanup-test-secret";
let res = await call();
const take = calls.find((c) => c.u.endsWith("/rpc/media_cleanup_take"));
const deletes = calls.filter((c) => c.method === "DELETE").map((c) => c.u.replace("https://r2.test/bucket/", ""));
const done = calls.find((c) => c.u.endsWith("/rpc/media_cleanup_done"));
ok("the upload link is still returned", res.status === 200 && !!(await res.json()).url);
ok("queued files are leased with the server secret", take?.body?.p_key === "cleanup-test-secret");
ok("each leased file is deleted from storage", deletes.sort().join(",") === "q/one,q/three,q/two", deletes.join(","));
ok("only files confirmed gone are finished (deleted, or already missing); the failed one stays queued",
  JSON.stringify(done?.body?.p_items) === JSON.stringify([{ id: 1, claim: "c1" }, { id: 2, claim: "c2" }]) && done?.body?.p_key === "cleanup-test-secret",
  JSON.stringify(done?.body?.p_items));

delete process.env.PUSH_SERVER_SECRET;
calls = [];
res = await call();
ok("without the server secret: the upload still works and the queue isn't touched",
  res.status === 200 && !calls.some((c) => /media_cleanup|DELETE/.test(c.u + c.method)));

await vite.close();
console.log(failures ? `${failures} FAILURE(S)` : "ALL MEDIA CLEANUP TESTS PASSED");
process.exit(failures ? 1 : 0);
