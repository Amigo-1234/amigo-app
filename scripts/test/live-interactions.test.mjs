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
import { createHash, randomBytes } from "node:crypto";
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
  // Vercel adds its feedback toolbar to preview deployments (never to production); at phone
  // size it covers the Reply button. Hide it so the test sees the app as production serves it.
  await ctx.addInitScript(() => {
    const hide = () => {
      const st = document.createElement("style");
      st.textContent = "vercel-live-feedback{display:none!important}";
      document.documentElement.appendChild(st);
    };
    if (document.documentElement) hide();
    else document.addEventListener("DOMContentLoaded", hide);
  });
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
  // How many different sign-in tokens the app uses (hashed here, never printed).
  const tokenHashes = new Set();
  let dataRequests = 0;
  let pageLoads = 0;
  page.on("framenavigated", (f) => f === page.mainFrame() && pageLoads++);
  page.on("request", (rq) => {
    if (!isData(new URL(rq.url()))) return;
    dataRequests++;
    const auth = rq.headers()["authorization"];
    if (auth) tokenHashes.add(createHash("sha256").update(auth).digest("hex").slice(0, 12));
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
    // What the reply box and the page are doing just before the tap (5 s, every 250 ms).
    {
      const submit = page.locator("form.reply-composer button[type=submit]");
      const samples = [];
      let requests = 0;
      const count = (rq) => isData(new URL(rq.url())) && requests++;
      page.on("request", count);
      for (let i = 0; i < 20; i++) {
        const box = await submit.boundingBox().catch(() => null);
        samples.push(`${(await submit.isDisabled().catch(() => null)) ? "D" : "e"}${box ? Math.round(box.y) : "-"}:${(await input.inputValue().catch(() => "?")).length}`);
        await page.waitForTimeout(250);
      }
      page.off("request", count);
      info("reply button before tapping (D=disabled e=enabled, y position, typed length)", samples.join(" "));
      info("database requests in those 5 s", String(requests));
      ok("the page is quiet before tapping Reply (no request storm)", requests <= 10, String(requests));
      // Is the page still drawing frames, and what is under the button's centre?
      const frames = await page.evaluate(() => new Promise((res) => {
        let n = 0;
        const tick = () => (n++, requestAnimationFrame(tick));
        requestAnimationFrame(tick);
        setTimeout(() => res(n), 1000);
      })).catch((e) => `error ${String(e).slice(0, 80)}`);
      info("animation frames drawn in 1 s", String(frames));
      const box = await submit.boundingBox().catch(() => null);
      if (box) {
        const top = await page.evaluate(({ x, y }) => {
          const el = document.elementFromPoint(x, y);
          if (!el) return "nothing";
          const d = (e) => `${e.tagName.toLowerCase()}${e.id ? `#${e.id}` : ""}${typeof e.className === "string" && e.className ? `.${e.className.trim().split(/\s+/).slice(0, 3).join(".")}` : ""}`;
          return el.closest("form.reply-composer") ? `the reply form (${d(el)})` : `${d(el)} inside ${el.parentElement ? d(el.parentElement) : "?"}`;
        }, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
        info("element under the Reply button's centre", top);
      }
      const vercelUi = await page.evaluate(() => [...document.querySelectorAll("vercel-live-feedback, [data-vercel-toolbar], iframe[src*='vercel.live']")].length);
      info("Vercel toolbar elements on the page", String(vercelUi));
    }
    timeline.length = 0;
    t0 = Date.now();
    const submitBtn = page.locator("form.reply-composer button[type=submit]");
    const normalClick = await submitBtn.click({ timeout: 5000 }).then(() => true, () => false);
    ok("UI: the Reply button can be tapped normally", normalClick);
    if (!normalClick) {
      // See whether the app itself works when the tap is delivered regardless.
      await submitBtn.dispatchEvent("click");
      info("tapped Reply directly (bypassing the stability check)");
    }
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
    // Straight after opening (a new page load gets a new sign-in token): reply at once.
    await page.goto(`${BASE}/post/${textPost}`, { waitUntil: "commit" });
    await input.waitFor({ timeout: 20000 });
    const quickText = `Quick reply ${tag}`;
    await input.fill(quickText);
    timeline.length = 0;
    t0 = Date.now();
    await page.locator("form.reply-composer button[type=submit]").click();
    const quick = await page.getByRole("region", { name: "Replies" }).getByText(quickText).first().waitFor({ timeout: 30000 }).then(() => true, () => false);
    const quickMs = Date.now() - t0;
    const quickErr = await page.locator(".reply-composer__error").textContent().catch(() => null);
    ok("UI: a reply sent the moment the post opens goes through", quick, quick ? "" : `${quickErr ?? "no error shown"} · ${recent()}`);
    ok("UI: …and appears within 5 s", quick && quickMs <= 5000, `${(quickMs / 1000).toFixed(1)} s`);
    info("requests after the quick reply", timeline.slice(0, 16).join(", "));
    const parent = await readPost(A, textPost);
    ok("the post counts all three replies", parent?.reply_count === 3, String(parent?.reply_count));
  }

  // A like the moment the app opens (new sign-in token), then a reload.
  for (let round = 1; round <= 3; round++) {
    await page.goto(`${BASE}/`, { waitUntil: "commit" });
    const card = page.locator("#feed-panel article", { hasText: `Like test text ${tag}` }).first();
    if (!(await card.waitFor({ timeout: 20000 }).then(() => true, () => false))) {
      ok(`UI: quick like ${round}: the post is in the feed`, false, recent());
      continue;
    }
    const btn = likeButton(card);
    const before = await btn.getAttribute("aria-pressed");
    await btn.click();
    await page.waitForTimeout(3000);
    const want = before === "true" ? "false" : "true";
    const p = await readPost(B, textPost);
    const dbOk = want === "true" ? p?.liked === true && p?.like_count === 1 : p?.liked === false && p?.like_count === 0;
    ok(`UI: quick ${want === "true" ? "like" : "unlike"} ${round} right after opening reaches the database`, dbOk, `${JSON.stringify({ count: p?.like_count, liked: p?.liked })} · ${recent()}`);
    ok(`UI: …and the heart shows it`, (await btn.getAttribute("aria-pressed")) === want, JSON.stringify(await state(btn)));
  }
  // A like the server refuses (the author blocked the liker after the feed loaded): the app
  // must undo the heart, say so, and record the failure in the error log.
  {
    const doomed = idOf(await rpc(A, "create_post", { p_body: `Refused like ${tag}`, p_media: [] }));
    await open("/");
    const card = page.locator("#feed-panel article", { hasText: `Refused like ${tag}` }).first();
    if (doomed && (await card.waitFor({ timeout: 20000 }).then(() => true, () => false))) {
      await rpc(A, "dm_block", { p_user: B.id });
      const startedAt = new Date().toISOString();
      await likeButton(card).click();
      const toast = await page.locator(".toast").filter({ hasText: /Couldn.t like/ }).first().waitFor({ timeout: 8000 }).then(() => true, () => false);
      await page.waitForTimeout(3000); // the report goes out 1.5 s after the failure
      ok("UI: a refused like says so", toast);
      ok("UI: …and the heart is undone", (await likeButton(card).getAttribute("aria-pressed").catch(() => "false")) === "false");
      info("refused like at (for the error-log check)", startedAt);
    } else ok("UI: refused-like setup", false, recent());
  }
  info("sign-in tokens used by the app in this session", `${tokenHashes.size} different, over ${dataRequests} database requests and ${pageLoads} page loads`);
  ok("the app reuses its sign-in token (about one per page load, not one per request)", tokenHashes.size <= pageLoads + 2, `${tokenHashes.size} tokens / ${pageLoads} page loads / ${dataRequests} requests`);
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
