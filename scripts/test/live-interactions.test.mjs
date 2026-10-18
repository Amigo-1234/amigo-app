/**
 * Likes and replies, end to end on a deployed environment (real Neon + the app's
 * own UI): like / unlike, counts, state after a reload, publishing a reply,
 * seeing it at once and after a reload, liking a reply. Text and photo posts.
 *
 *   BASE=https://<domain> VERCEL_BYPASS=… node scripts/test/live-interactions.test.mjs
 *
 * Signs up two temporary accounts and deletes them at the end (their posts,
 * likes and files go with them). Prints no secrets, tokens or signed URLs.
 */
import { randomBytes } from "node:crypto";
import { chromium, webkit, devices } from "playwright";

const { BASE, VERCEL_BYPASS, ENGINE = "chromium" } = process.env;
if (!BASE || !VERCEL_BYPASS) throw new Error("Set BASE and VERCEL_BYPASS");
const BYPASS = { "x-vercel-protection-bypass": VERCEL_BYPASS };

let failures = 0;
const ok = (label, cond, extra = "") => {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
};
const info = (label, extra) => console.log(`info ${label}${extra ? ` — ${extra}` : ""}`);

async function account(tag, who) {
  const email = `amigo-e2e-${tag}-${who}@example.com`;
  const password = randomBytes(18).toString("base64url");
  const res = await fetch(`${BASE}/neon/auth/sign-up/email`, {
    method: "POST",
    headers: { ...BYPASS, origin: BASE, "content-type": "application/json" },
    body: JSON.stringify({ email, password, name: `Like Test ${who.toUpperCase()}` }),
  });
  if (!res.ok) throw new Error(`sign-up ${who}: ${res.status}`);
  const body = await res.json();
  const cookies = res.headers.getSetCookie();
  const cookie = cookies.map((c) => c.split(";")[0]).join("; ");
  const { token } = await (await fetch(`${BASE}/neon/auth/token`, { headers: { ...BYPASS, origin: BASE, cookie } })).json();
  return { id: body.user.id, token, cookies, email, password };
}
async function signInAgain(p) {
  const res = await fetch(`${BASE}/neon/auth/sign-in/email`, {
    method: "POST",
    headers: { ...BYPASS, origin: BASE, "content-type": "application/json" },
    body: JSON.stringify({ email: p.email, password: p.password }),
  });
  if (!res.ok) return;
  const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const t = await (await fetch(`${BASE}/neon/auth/token`, { headers: { ...BYPASS, origin: BASE, cookie } })).json().catch(() => ({}));
  if (t.token) p.token = t.token;
}
const api = async (who, path, init = {}) => {
  const res = await fetch(`${BASE}/neon/rest/v1/${path}`, {
    ...init,
    headers: { ...BYPASS, authorization: `Bearer ${who.token}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = text.slice(0, 200);
  }
  return { status: res.status, data };
};
const rpc = (who, fn, args = {}) => api(who, `rpc/${fn}`, { method: "POST", body: JSON.stringify(args) });
const idOf = (r) => (typeof r.data === "string" ? r.data : r.data?.id);
// What the app reads for a post (the parts that matter here).
const POST_FIELDS = "id,like_count,reply_count,liked,author:profiles!posts_author_id_fkey(id,username),media:post_media(kind,position)";
const readPost = async (who, id) => (await api(who, `posts?select=${encodeURIComponent(POST_FIELDS)}&id=eq.${id}`)).data?.[0] ?? null;

const tag = randomBytes(4).toString("hex");
const people = [];
const browser = await (ENGINE === "webkit" ? webkit : chromium).launch();
console.log(`info browser engine: ${ENGINE}`);
const deadline = setTimeout(() => {
  console.log("FAIL took over 8 minutes; stopping");
  failures++;
  void browser.close();
}, 8 * 60_000);

try {
  const A = await account(tag, "a"); // author
  people.push(A);
  const B = await account(tag, "b"); // likes and replies
  people.push(B);
  try {
    const claims = JSON.parse(Buffer.from(B.token.split(".")[1], "base64url").toString());
    info("sign-in token lifetime", `${Math.round((claims.exp - claims.iat) / 60)} min`);
  } catch {
    info("sign-in token lifetime", "unknown");
  }

  // ------------------------------------------------------------- API level
  const first = await rpc(A, "create_post", { p_body: `Like test text ${tag}`, p_media: [] });
  let textPost = idOf(first);
  if (!textPost) {
    // Record why, then see whether it was a one-off (a retry a moment later).
    info("first write of a new account was refused", `${first.status} ${typeof first.data === "string" ? first.data : JSON.stringify(first.data).slice(0, 200)}`);
    await new Promise((r) => setTimeout(r, 2000));
    const again = await rpc(A, "create_post", { p_body: `Like test text ${tag}`, p_media: [] });
    textPost = idOf(again);
    info("…the same request 2 s later", `${again.status}${textPost ? " (accepted)" : ` ${JSON.stringify(again.data).slice(0, 200)}`}`);
  }
  ok("author creates a text post", !!textPost);
  // A photo post needs a real upload.
  const png = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000" + "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082", "hex");
  const up = await fetch(`${BASE}/api/media-upload`, {
    method: "POST",
    headers: { ...BYPASS, authorization: `Bearer ${A.token}`, "content-type": "application/json" },
    body: JSON.stringify({ purpose: "post", mime: "image/png", size: png.length }),
  }).then((r) => r.json()).catch(() => null);
  let photoPost = null;
  if (up?.url && up?.key) {
    const put = await fetch(up.url, { method: "PUT", headers: { "content-type": "image/png", ...(up.headers ?? {}) }, body: png });
    if (put.ok) {
      photoPost = idOf(await rpc(A, "create_post", { p_body: `Like test photo ${tag}`, p_media: [{ kind: "image", storage_path: up.key, mime_type: "image/png", width: 1, height: 1, byte_size: png.length }] }));
    }
  }
  ok("author creates a photo post", !!photoPost);

  for (const [kind, id] of [["text", textPost], ["photo", photoPost]]) {
    if (!id) continue;
    let r = await rpc(B, "set_post_like", { p_post_id: id, p_liked: true });
    ok(`API: like a ${kind} post`, r.status === 200 || r.status === 204, `${r.status} ${typeof r.data === "string" ? r.data : JSON.stringify(r.data ?? "").slice(0, 160)}`);
    let p = await readPost(B, id);
    ok(`API: ${kind} post count is 1 and it reads as liked`, p?.like_count === 1 && p?.liked === true, JSON.stringify({ count: p?.like_count, liked: p?.liked }));
    r = await rpc(B, "set_post_like", { p_post_id: id, p_liked: false });
    p = await readPost(B, id);
    ok(`API: unlike a ${kind} post (count 0, not liked)`, (r.status === 200 || r.status === 204) && p?.like_count === 0 && p?.liked === false, `${r.status} ${JSON.stringify({ count: p?.like_count, liked: p?.liked })}`);
  }
  let r = await rpc(B, "create_post", { p_body: `API reply ${tag}`, p_parent_id: textPost, p_media: [] });
  const apiReply = idOf(r);
  ok("API: reply to a post", !!apiReply, `${r.status} ${typeof r.data === "string" ? r.data.slice(0, 160) : ""}`);
  const replies = await api(B, `posts?select=${encodeURIComponent(POST_FIELDS + ",body")}&parent_id=eq.${textPost}`);
  ok("API: the reply is listed under the post", replies.data?.some?.((x) => x.id === apiReply), String(replies.status));
  ok("API: the post's reply count is 1", (await readPost(A, textPost))?.reply_count === 1);
  r = await rpc(A, "set_post_like", { p_post_id: apiReply, p_liked: true });
  ok("API: like a reply", (r.status === 200 || r.status === 204) && (await readPost(A, apiReply))?.liked === true, String(r.status));
  await rpc(A, "set_post_like", { p_post_id: apiReply, p_liked: false });

  // ------------------------------------------------------------- the app's UI
  const host = new URL(BASE).hostname;
  const ctx = await browser.newContext({ ...devices["iPhone 13"] });
  await ctx.request.get(BASE, { headers: { ...BYPASS, "x-vercel-set-bypass-cookie": "true" }, maxRedirects: 0 });
  await ctx.addCookies(
    B.cookies.map((raw) => {
      const [pair] = raw.split(";");
      const i = pair.indexOf("=");
      return { name: pair.slice(0, i), value: pair.slice(i + 1), domain: host, path: "/", secure: true, httpOnly: /httponly/i.test(raw), sameSite: "Lax" };
    }),
  );
  const page = await ctx.newPage();
  page.setDefaultTimeout(15000);
  const problems = [];
  page.on("pageerror", (e) => problems.push(`page error: ${e.message.slice(0, 160)}`));
  page.on("console", (m) => m.type() === "error" && problems.push(`console: ${m.text().slice(0, 200)}`));
  page.on("response", (res) => {
    const u = new URL(res.url());
    if (res.status() >= 400 && (u.pathname.startsWith("/neon/") || u.pathname.startsWith("/api/") || u.hostname.includes(".apirest.")))
      problems.push(`${res.request().method()} ${u.pathname.replace(/[0-9a-f-]{32,}/g, "…")} ${res.status()}`);
  });
  const recent = () => problems.splice(0).slice(-6).join(" | ") || "no errors seen";
  // When each request to the database started and finished (path only, no ids or values).
  const timeline = [];
  // Database calls go to the same-origin proxy or straight to Neon's Data API.
  const isData = (u) => u.pathname.startsWith("/neon/rest/") || (u.hostname.includes(".apirest.") && u.pathname.includes("/rest/v1/"));
  const dataPath = (u) => u.pathname.replace(/^.*\/rest\/v1\//, "").replace(/[0-9a-f-]{32,}/g, "…");
  let t0 = Date.now();
  const mark = (what) => timeline.push(`${what} +${((Date.now() - t0) / 1000).toFixed(1)}s`);
  page.on("request", (rq) => {
    const u = new URL(rq.url());
    if (isData(u)) mark(`→ ${rq.method()} ${dataPath(u)}`);
  });
  page.on("requestfinished", async (rq) => {
    const u = new URL(rq.url());
    if (isData(u)) mark(`← ${(await rq.response())?.status() ?? "?"} ${dataPath(u)}`);
  });
  page.on("requestfailed", (rq) => {
    const u = new URL(rq.url());
    if (isData(u)) mark(`✗ ${dataPath(u)} (${rq.failure()?.errorText ?? "failed"})`);
  });
  const open = async (path) => {
    await page.goto(`${BASE}${path}`, { waitUntil: "networkidle" });
    const agree = page.getByRole("button", { name: "I agree" });
    if (await agree.isVisible().catch(() => false)) {
      await agree.click();
      await page.waitForLoadState("networkidle");
    }
  };
  const likeButton = (scope) => scope.locator("button.action--like").first();
  const state = async (btn) => ({ pressed: await btn.getAttribute("aria-pressed"), label: await btn.getAttribute("aria-label") });
  const waitFor = async (fn, ms = 10000) => {
    for (let t = 0; t < ms; t += 250) {
      if (await fn().catch(() => false)) return true;
      await page.waitForTimeout(250);
    }
    return false;
  };

  for (const [kind, id, text] of [["text", textPost, `Like test text ${tag}`], ["photo", photoPost, `Like test photo ${tag}`]]) {
    if (!id) continue;
    // In the feed.
    await open("/");
    const card = page.locator("#feed-panel article", { hasText: text }).first();
    const inFeed = await card.waitFor({ timeout: 20000 }).then(() => true, () => false);
    ok(`UI: the ${kind} post is in the feed`, inFeed, inFeed ? "" : recent());
    if (!inFeed) continue;
    let btn = likeButton(card);
    await btn.click();
    const shown = await waitFor(async () => (await btn.getAttribute("aria-pressed")) === "true");
    ok(`UI: tapping Like on a ${kind} post shows it liked`, shown, JSON.stringify(await state(btn)));
    await page.waitForTimeout(2500); // let the request finish and the feed refresh
    const stayed = (await btn.getAttribute("aria-pressed")) === "true";
    ok(`UI: …and it stays liked (count 1)`, stayed && /\b1 like\b/.test((await btn.getAttribute("aria-label")) ?? ""), `${JSON.stringify(await state(btn))} · ${recent()}`);
    const p = await readPost(B, id);
    ok(`UI: the ${kind} like reached the database`, p?.like_count === 1 && p?.liked === true, JSON.stringify({ count: p?.like_count, liked: p?.liked }));
    await page.reload({ waitUntil: "networkidle" });
    const card2 = page.locator("#feed-panel article", { hasText: text }).first();
    await card2.waitFor({ timeout: 20000 }).catch(() => undefined);
    btn = likeButton(card2);
    ok(`UI: after a reload the ${kind} post is still liked`, (await btn.getAttribute("aria-pressed").catch(() => null)) === "true", JSON.stringify(await state(btn).catch(() => ({}))));
    await btn.click();
    await waitFor(async () => (await btn.getAttribute("aria-pressed")) === "false");
    await page.waitForTimeout(2500);
    ok(`UI: unliking a ${kind} post shows 0 likes`, (await btn.getAttribute("aria-pressed")) === "false" && /\b0 likes\b/.test((await btn.getAttribute("aria-label")) ?? ""), `${JSON.stringify(await state(btn))} · ${recent()}`);
    await page.reload({ waitUntil: "networkidle" });
    const card3 = page.locator("#feed-panel article", { hasText: text }).first();
    await card3.waitFor({ timeout: 20000 }).catch(() => undefined);
    ok(`UI: after a reload the ${kind} post is still unliked`, (await likeButton(card3).getAttribute("aria-pressed").catch(() => null)) === "false");
  }

  // Replies on the post's page.
  await open(`/post/${textPost}`);
  const input = page.locator("#reply-input");
  const hasComposer = await input.waitFor({ timeout: 20000 }).then(() => true, () => false);
  ok("UI: the post page shows the reply box", hasComposer, hasComposer ? "" : recent());
  if (hasComposer) {
    const replyText = `UI reply ${tag}`;
    await page.waitForTimeout(3000); // the page has settled
    await input.fill(replyText);
    timeline.length = 0;
    t0 = Date.now();
    await page.locator("form.reply-composer button[type=submit]").click();
    const replies = page.getByRole("region", { name: "Replies" });
    const appeared = await replies.getByText(replyText).first().waitFor({ timeout: 30000 }).then(() => true, () => false);
    const replyMs = Date.now() - t0;
    const err = await page.locator(".reply-composer__error").textContent().catch(() => null);
    ok("UI: a new reply appears", appeared, appeared ? "" : `${err ?? "no error shown"} · ${recent()}`);
    ok("UI: …within 5 s of tapping Reply", appeared && replyMs <= 5000, `${(replyMs / 1000).toFixed(1)} s`);
    info("requests after tapping Reply", timeline.slice(0, 14).join(", "));
    ok("UI: the reply box is cleared after sending", (await input.inputValue()) === "");
    await page.reload({ waitUntil: "networkidle" });
    const kept = await page.getByRole("region", { name: "Replies" }).getByText(replyText).first().waitFor({ timeout: 15000 }).then(() => true, () => false);
    ok("UI: the reply is still there after a reload", kept);
    // Interact with an existing reply (the one made through the API).
    const row = page.getByRole("region", { name: "Replies" }).locator("article, li, div").filter({ hasText: `API reply ${tag}` }).last();
    const replyLike = row.locator('button[aria-label^="Like reply"], button[aria-label^="Unlike reply"]').first();
    const hasLike = await replyLike.waitFor({ timeout: 10000 }).then(() => true, () => false);
    ok("UI: existing replies have a like button", hasLike);
    if (hasLike) {
      await replyLike.click();
      await page.waitForTimeout(2500);
      ok("UI: liking a reply shows it liked", /^Unlike reply\. 1 like/.test((await replyLike.getAttribute("aria-label")) ?? ""), (await replyLike.getAttribute("aria-label")) ?? "");
      const db = await readPost(B, apiReply);
      ok("UI: the reply like reached the database", db?.like_count === 1 && db?.liked === true, JSON.stringify({ count: db?.like_count, liked: db?.liked }));
      await page.reload({ waitUntil: "networkidle" });
      const again = page.getByRole("region", { name: "Replies" }).locator('button[aria-label^="Unlike reply"]').first();
      ok("UI: the reply like survives a reload", await again.waitFor({ timeout: 10000 }).then(() => true, () => false));
    }
    const parent = await readPost(A, textPost);
    ok("the post counts both replies", parent?.reply_count === 2, String(parent?.reply_count));
  }
  const left = problems.splice(0);
  if (left.length) info("errors seen in the app", left.slice(-8).join(" | "));
} catch (e) {
  failures++;
  console.log(`FAIL stopped: ${String(e?.message ?? e).slice(0, 300)}`);
} finally {
  clearTimeout(deadline);
  await browser.close().catch(() => undefined);
  for (const p of people) {
    await signInAgain(p);
    const d = await rpc(p, "delete_my_account", { p_confirm: "DELETE" }).catch(() => ({ status: 0 }));
    const done = d.status === 200 || d.status === 204;
    if (!done) failures++;
    console.log(`cleanup: temporary account ${done ? "deleted" : `NOT deleted (${d.status}) id=${p.id}`}`);
  }
}
console.log(failures ? `${failures} FAILED` : "ALL LIKE AND REPLY TESTS PASSED");
process.exit(failures ? 1 : 0);
