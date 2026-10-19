/**
 * Direct messages on a deployed environment, through the app's UI on two
 * iPhone-sized browsers with two temporary accounts A and B:
 *
 *   both open Messages (each gets an encryption device) → A opens B's profile →
 *   Message → sends text → B (on Home) gets an in-app banner and an unread
 *   badge → B opens the conversation and reads it (decrypted on B's device) →
 *   B replies while A has the conversation open → A sees it without reloading →
 *   B "closes and reopens" the app (new page, same storage, new sign-in token)
 *   → inbox and conversation load and still decrypt. B also sends while A is in
 *   the inbox (no banner for the inbox you're looking at).
 *
 *   BASE=https://<domain> VERCEL_BYPASS=… [ENGINE=webkit] node scripts/test/live-messages.test.mjs
 *
 * Both accounts are deleted at the end. Prints no secrets or message keys.
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function account(tag, who) {
  const email = `amigo-e2e-${tag}-${who}@example.com`;
  const password = randomBytes(18).toString("base64url");
  const res = await fetch(`${BASE}/neon/auth/sign-up/email`, {
    method: "POST",
    headers: { ...BYPASS, origin: BASE, "content-type": "application/json" },
    body: JSON.stringify({ email, password, name: `DM Test ${who.toUpperCase()} ${tag}` }),
  });
  if (!res.ok) throw new Error(`sign-up ${who}: ${res.status}`);
  const body = await res.json();
  const cookies = res.headers.getSetCookie();
  const cookie = cookies.map((c) => c.split(";")[0]).join("; ");
  const { token } = await (await fetch(`${BASE}/neon/auth/token`, { headers: { ...BYPASS, origin: BASE, cookie } })).json();
  await sleep(800);
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
  await sleep(800);
}
const api = async (who, path, init = {}) => {
  const res = await fetch(`${BASE}/neon/rest/v1/${path}`, {
    ...init,
    headers: { ...BYPASS, authorization: `Bearer ${who.token}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });
  const text = await res.text();
  try {
    return { status: res.status, data: JSON.parse(text) };
  } catch {
    return { status: res.status, data: text.slice(0, 200) };
  }
};
const rpc = (who, fn, args = {}) => api(who, `rpc/${fn}`, { method: "POST", body: JSON.stringify(args) });

const tag = randomBytes(3).toString("hex");
const people = [];
const browser = await (ENGINE === "webkit" ? webkit : chromium).launch();
console.log(`info browser engine: ${ENGINE}`);
const deadline = setTimeout(() => {
  console.log("FAIL took over 9 minutes; stopping");
  failures++;
  void browser.close();
}, 9 * 60_000);

const host = new URL(BASE).hostname;
async function phone(p, name) {
  const ctx = await browser.newContext({ ...devices["iPhone 13"] });
  await ctx.request.get(BASE, { headers: { ...BYPASS, "x-vercel-set-bypass-cookie": "true" }, maxRedirects: 0 });
  await ctx.addCookies(
    p.cookies.map((raw) => {
      const [pair] = raw.split(";");
      const i = pair.indexOf("=");
      return { name: pair.slice(0, i), value: pair.slice(i + 1), domain: host, path: "/", secure: true, httpOnly: /httponly/i.test(raw), sameSite: "Lax" };
    }),
  );
  await ctx.addInitScript(() => {
    const hide = () => {
      const st = document.createElement("style");
      st.textContent = "vercel-live-feedback{display:none!important}";
      document.documentElement.appendChild(st);
    };
    if (document.documentElement) hide();
    else document.addEventListener("DOMContentLoaded", hide);
  });
  const problems = [];
  const failedCalls = [];
  const watch = (page) => {
    page.setDefaultTimeout(20000);
    page.on("pageerror", (e) => problems.push(`${name} page error: ${e.message.slice(0, 200)}`));
    page.on("console", (m) => {
      // WebKit logs cancelled cross-origin fetches as "access control checks"; not an app error.
      if (m.type() === "error" && !/access control checks/i.test(m.text())) problems.push(`${name} console: ${m.text().slice(0, 200)}`);
    });
    page.on("response", (r) => {
      const u = new URL(r.url());
      if (u.pathname.startsWith("/neon/") && r.status() >= 400) failedCalls.push(`${name} ${r.status()} ${u.pathname.replace(/[0-9a-f-]{36}/g, "<id>")}`);
    });
  };
  const open = async (path) => {
    const page = await ctx.newPage();
    watch(page);
    await page.goto(`${BASE}${path}`, { waitUntil: "networkidle" });
    const agree = page.getByRole("button", { name: "I agree" });
    await agree.waitFor({ timeout: 6000 }).catch(() => undefined);
    if (await agree.isVisible().catch(() => false)) {
      await agree.click();
      await agree.waitFor({ state: "detached", timeout: 15000 }).catch(() => undefined);
    }
    return page;
  };
  return { ctx, open, problems, failedCalls };
}
const text = async (page, sel = "main") => ((await page.locator(sel).first().innerText().catch(() => "")) || "").replace(/\s+/g, " ").slice(0, 240);
async function waitFor(loc, ms) {
  try {
    await loc.waitFor({ timeout: ms });
    return true;
  } catch {
    return false;
  }
}

try {
  const A = await account(tag, "a");
  people.push(A);
  const B = await account(tag, "b");
  people.push(B);
  const bHandle = (await api(B, `profiles?select=username&id=eq.${B.id}`)).data?.[0]?.username;

  const phoneA = await phone(A, "A");
  const phoneB = await phone(B, "B");

  // 1. Both open Messages: each gets an encryption device.
  let pageB = await phoneB.open("/messages");
  const pageA = await phoneA.open("/messages");
  await sleep(3000);
  ok("A's messaging is ready (no device prompt)", !(await pageA.getByText("Confirm it's you").isVisible().catch(() => false)), await text(pageA));
  ok("B's messaging is ready (no device prompt)", !(await pageB.getByText("Confirm it's you").isVisible().catch(() => false)), await text(pageB));

  // B goes to Home and waits there.
  await pageB.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await sleep(2000);

  // 2. A → B's profile → Message → send.
  await pageA.goto(`${BASE}/u/${bHandle}`, { waitUntil: "networkidle" });
  await pageA.getByRole("button", { name: /^Message / }).click();
  ok("A's conversation with B opens", await pageA.waitForURL(/\/messages\/[0-9a-f-]{36}/, { timeout: 30000 }).then(() => true, () => false), pageA.url());
  const conversation = new URL(pageA.url()).pathname;
  const input = pageA.locator("#msg-input");
  ok("composer is shown", await waitFor(input, 20000), await text(pageA));
  ok("an empty conversation offers “Break the ice”", await waitFor(pageA.getByRole("group", { name: "Break the ice" }), 8000));
  const first = `Hello from A ${tag}`;
  await input.fill(first);
  const t0 = Date.now();
  await pageA.getByRole("button", { name: "Send", exact: true }).click();
  const mine = pageA.locator(".msg--mine:not(.is-pending)", { hasText: first });
  ok("A's message is sent (shown as stored)", await waitFor(mine, 30000), `${Date.now() - t0} ms · ${await text(pageA, ".msgs")}`);
  ok("no send error on A's side", !(await pageA.locator(".msg__status--failed").count()));
  const row = await api(A, `dm_messages?select=content&order=created_at.desc&limit=1&conversation_id=eq.${conversation.split("/").pop()}`);
  ok("the server stores ciphertext only", JSON.stringify(row.data).includes("m.megolm.v1.aes-sha2") && !JSON.stringify(row.data).includes(first), String(row.status));

  // 3. B, on Home: banner, then open the conversation.
  const banner = pageB.locator(".inapp-banner", { hasText: `DM Test A ${tag}` });
  const tb = Date.now();
  const bannerShown = await waitFor(banner, 45000);
  ok("B (on Home) gets an in-app banner for the message", bannerShown, bannerShown ? `${Date.now() - tb} ms` : await text(pageB, ".main"));
  if (bannerShown) {
    ok("…the banner shows the decrypted text", (await banner.innerText()).includes(first), await banner.innerText());
    await banner.locator(".inapp-banner__main").click();
    ok("…tapping it opens the conversation", await pageB.waitForURL(`**${conversation}`, { timeout: 15000 }).then(() => true, () => false), pageB.url());
  } else {
    await pageB.goto(`${BASE}${conversation}`, { waitUntil: "networkidle" });
  }
  const theirs = pageB.locator(".msg--theirs", { hasText: first });
  ok("B sees A's message, decrypted", await waitFor(theirs, 30000), await text(pageB, "main"));

  // 4. B replies; A has the conversation open and sees it without reloading.
  const reply = `Reply from B ${tag}`;
  await pageB.locator("#msg-input").fill(reply);
  await pageB.getByRole("button", { name: "Send", exact: true }).click();
  ok("B's reply is sent", await waitFor(pageB.locator(".msg--mine:not(.is-pending)", { hasText: reply }), 30000), await text(pageB, ".msgs"));
  const ta = Date.now();
  const live = await waitFor(pageA.locator(".msg--theirs", { hasText: reply }), 45000);
  ok("A sees B's reply live in the open conversation", live, live ? `${Date.now() - ta} ms` : await text(pageA, ".msgs"));
  ok("no banner on A for the conversation A is reading", !(await pageA.locator(".inapp-banner").isVisible().catch(() => false)));

  // 5. A in the inbox; B sends again → the inbox updates.
  await pageA.goto(`${BASE}/messages`, { waitUntil: "networkidle" });
  const again = `Second from B ${tag}`;
  await pageB.locator("#msg-input").fill(again);
  await pageB.getByRole("button", { name: "Send", exact: true }).click();
  await waitFor(pageB.locator(".msg--mine:not(.is-pending)", { hasText: again }), 30000);
  ok("A's inbox shows B's newest message", await waitFor(pageA.locator("main", { hasText: again }), 45000), await text(pageA));

  // 6. B closes and reopens the app (same storage, new page, new sign-in token).
  await pageB.close();
  pageB = await phoneB.open("/messages");
  ok("after reopening, B's inbox lists the conversation with its last message", await waitFor(pageB.locator("main", { hasText: again }), 30000), await text(pageB));
  await pageB.goto(`${BASE}${conversation}`, { waitUntil: "networkidle" });
  const all = await Promise.all([first, reply, again].map((m) => waitFor(pageB.locator(".msg", { hasText: m }), 30000)));
  ok("after reopening, the whole conversation loads and decrypts", all.every(Boolean), all.join(","));
  ok("nothing shown as undecryptable", !(await pageB.getByText(/can.t be decrypted on this device/i).count()));

  const problems = [...phoneA.problems, ...phoneB.problems];
  const calls = [...phoneA.failedCalls, ...phoneB.failedCalls];
  if (calls.length) info("failed data calls", [...new Set(calls)].slice(0, 10).join(" | "));
  ok("no uncaught errors in either app", !problems.some((p) => /page error/.test(p)), problems.filter((p) => /page error/.test(p)).slice(0, 4).join(" | "));
  if (problems.length) info("console errors", [...new Set(problems)].slice(0, 8).join(" | "));
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
console.log(failures ? `${failures} FAILED` : "ALL MESSAGING TESTS PASSED");
process.exit(failures ? 1 : 0);
