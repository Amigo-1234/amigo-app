/**
 * The Neon client's fetch (src/data/supabase/freshToken.ts) against a stand-in
 * Data API that, like production, treats a brand-new sign-in token as signed
 * out for its first ~250 ms.
 *
 *   node scripts/test/fresh-token.test.mjs
 */
import { createServer } from "vite";

let failures = 0;
const ok = (label, cond, extra = "") => {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
};

// A stand-in Data API.
const issuedAt = new Map(); // token -> when "issued"
let honourAfterMs = 250;
const calls = [];
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  const token = new Headers(init.headers).get("Authorization")?.replace("Bearer ", "");
  const honoured = token && Date.now() - issuedAt.get(token) >= honourAfterMs;
  calls.push({ url, method: init.method ?? "GET", honoured, body: init.body, at: Date.now() });
  if (url.includes("/rpc/forbidden")) return new Response(JSON.stringify({ code: "42501", message: "permission denied for function forbidden" }), { status: 403 });
  if (!honoured && init.method === "POST" && !url.includes("feed_posts"))
    return new Response(JSON.stringify({ code: "42501", message: "not signed in" }), { status: 403 });
  return new Response(JSON.stringify({ honoured }), { status: 200 });
};
const events = [];
globalThis.window = { dispatchEvent: (e) => events.push(e.type) };
globalThis.Event = class { constructor(type) { this.type = type; } };

const vite = await createServer({ server: { middlewareMode: true }, appType: "custom", logLevel: "error" });
try {
  const { dataFetch, FRESH_TOKEN_REREAD_EVENT } = await vite.ssrLoadModule("/src/data/supabase/freshToken.ts");
  const issue = (name) => (issuedAt.set(name, Date.now()), name);
  const auth = (t) => ({ headers: { Authorization: `Bearer ${t}`, "content-type": "application/json" } });

  // A like right after a new token: waits instead of being refused.
  let t = issue("t1");
  calls.length = 0;
  let start = Date.now();
  let res = await dataFetch("https://db/rest/v1/rpc/set_post_like", { ...auth(t), method: "POST", body: "{}" });
  ok("a like sent with a brand-new token succeeds", res.status === 200, String(res.status));
  ok("…without ever reaching the database signed out", calls.every((c) => c.honoured), JSON.stringify(calls.map((c) => c.honoured)));
  ok("…and waits at most about half a second", Date.now() - start < 900, `${Date.now() - start} ms`);

  // Later requests with the same token go out at once.
  calls.length = 0;
  start = Date.now();
  await dataFetch("https://db/rest/v1/rpc/create_post", { ...auth(t), method: "POST", body: "{}" });
  ok("later changes with the same token are not delayed", Date.now() - start < 100, `${Date.now() - start} ms`);

  // If the database takes longer than the wait, the refused change is retried.
  honourAfterMs = 1100;
  t = issue("t2");
  calls.length = 0;
  res = await dataFetch("https://db/rest/v1/rpc/create_post", { ...auth(t), method: "POST", body: '{"p_body":"hi"}' });
  ok("a reply refused as signed out is retried until it goes through", res.status === 200 && calls.length > 1, `${res.status} after ${calls.length} tries`);
  ok("…sending the same body each time", calls.every((c) => c.body === '{"p_body":"hi"}'));
  honourAfterMs = 250;

  // Real permission errors are not retried.
  t = issue("t3");
  await new Promise((r) => setTimeout(r, 600));
  calls.length = 0;
  res = await dataFetch("https://db/rest/v1/rpc/forbidden", { ...auth(t), method: "POST", body: "{}" });
  ok("a genuine permission error is returned at once (no retries)", res.status === 403 && calls.length === 1, String(calls.length));

  // Reads are never delayed; if they used a brand-new token the views are read again.
  t = issue("t4");
  calls.length = 0;
  events.length = 0;
  start = Date.now();
  await dataFetch("https://db/rest/v1/posts?select=id", { ...auth(t), method: "GET" });
  await dataFetch("https://db/rest/v1/rpc/feed_posts", { ...auth(t), method: "POST", body: "{}" });
  ok("reads go out at once, even with a brand-new token", Date.now() - start < 100, `${Date.now() - start} ms`);
  await new Promise((r) => setTimeout(r, 1200));
  ok("…and the open views are read again once the token is honoured (once)", events.filter((e) => e === FRESH_TOKEN_REREAD_EVENT).length === 1, JSON.stringify(events));

  // Requests without a token (signed out) pass straight through.
  calls.length = 0;
  res = await dataFetch("https://db/rest/v1/rpc/create_post", { method: "POST", body: "{}" });
  ok("signed-out requests pass straight through", calls.length === 1);
} finally {
  await vite.close();
}
console.log(failures ? `${failures} FAILED` : "ALL FRESH-TOKEN TESTS PASSED");
process.exit(failures ? 1 : 0);
