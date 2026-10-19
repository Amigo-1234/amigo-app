/**
 * Admin control centre on a deployed environment: the database refuses every
 * admin call from a non-admin, and for an admin the metrics, account search,
 * notes and suspend / restore work end to end (including that a suspended
 * account really can't post). Screenshots of the admin screens are printed as
 * base64 JPEG lines ("SHOT <name> <data>") so they can be read from the log.
 *
 * Admin rights can't be granted from the app (no public admin sign-up). The
 * test signs up amigo-e2e-<ADMIN_NONCE>-admin@example.com and waits up to five
 * minutes for an operator to add that account to app_admins; both temporary
 * accounts are deleted at the end, which also removes the admin grant.
 *
 *   BASE=… VERCEL_BYPASS=… ADMIN_NONCE=… node scripts/test/live-admin.test.mjs
 */
import { randomBytes } from "node:crypto";
import { chromium, devices } from "playwright";

const { BASE, VERCEL_BYPASS, ADMIN_NONCE } = process.env;
if (!BASE || !VERCEL_BYPASS || !ADMIN_NONCE) throw new Error("Set BASE, VERCEL_BYPASS and ADMIN_NONCE");
const BYPASS = { "x-vercel-protection-bypass": VERCEL_BYPASS };

let failures = 0;
const ok = (label, cond, extra = "") => {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
};
const info = (label, extra) => console.log(`info ${label}${extra ? ` — ${extra}` : ""}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function account(email, name) {
  const password = randomBytes(18).toString("base64url");
  const res = await fetch(`${BASE}/neon/auth/sign-up/email`, {
    method: "POST",
    headers: { ...BYPASS, origin: BASE, "content-type": "application/json" },
    body: JSON.stringify({ email, password, name }),
  });
  if (!res.ok) throw new Error(`sign-up: ${res.status}`);
  const body = await res.json();
  const cookies = res.headers.getSetCookie();
  const cookie = cookies.map((c) => c.split(";")[0]).join("; ");
  const { token } = await (await fetch(`${BASE}/neon/auth/token`, { headers: { ...BYPASS, origin: BASE, cookie } })).json();
  await sleep(600);
  return { id: body.user.id, token, cookies, email, password };
}
async function signInAgain(p) {
  const res = await fetch(`${BASE}/neon/auth/sign-in/email`, {
    method: "POST",
    headers: { ...BYPASS, origin: BASE, "content-type": "application/json" },
    body: JSON.stringify({ email: p.email, password: p.password }),
  });
  if (!res.ok) return;
  p.cookies = res.headers.getSetCookie();
  const cookie = p.cookies.map((c) => c.split(";")[0]).join("; ");
  const t = await (await fetch(`${BASE}/neon/auth/token`, { headers: { ...BYPASS, origin: BASE, cookie } })).json().catch(() => ({}));
  if (t.token) p.token = t.token;
  await sleep(600);
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
const refused = (r) => r.status === 401 || r.status === 403;

const tag = randomBytes(3).toString("hex");
const people = [];
const browser = await chromium.launch();
const deadline = setTimeout(() => {
  console.log("FAIL took over 12 minutes; stopping");
  failures++;
  void browser.close();
}, 12 * 60_000);

async function phone(who) {
  const host = new URL(BASE).hostname;
  const ctx = await browser.newContext({ ...devices["iPhone 13"], deviceScaleFactor: 1 });
  await ctx.request.get(BASE, { headers: { ...BYPASS, "x-vercel-set-bypass-cookie": "true" }, maxRedirects: 0 });
  await ctx.addCookies(
    who.cookies.map((raw) => {
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
  const page = await ctx.newPage();
  page.setDefaultTimeout(20000);
  page.on("dialog", (d) => void d.accept());
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  const agree = page.getByRole("button", { name: "I agree" });
  await agree.waitFor({ timeout: 8000 }).catch(() => undefined);
  if (await agree.isVisible().catch(() => false)) await agree.click();
  return page;
}
async function shot(name, locator) {
  const buf = await locator.screenshot({ type: "jpeg", quality: 60 });
  console.log(`SHOT ${name} ${buf.toString("base64")}`);
}

try {
  const A = await account(`amigo-e2e-${ADMIN_NONCE}-admin@example.com`, "Admin Test");
  people.push(A);
  const Y = await account(`amigo-e2e-${tag}-member@example.com`, `Member Test ${tag}`);
  people.push(Y);
  const yHandle = (await api(Y, `profiles?select=username&id=eq.${Y.id}`)).data?.[0]?.username;
  info("member handle", yHandle);

  // ---------------------------------------------------- not an admin: refused by the database
  for (const [fn, args] of [
    ["admin_insights", {}],
    ["admin_user_search", { p_query: "" }],
    ["admin_user_detail", { p_user: A.id }],
    ["admin_add_note", { p_target_type: "user", p_target: A.id, p_note: "x" }],
    ["admin_target_history", { p_target: A.id }],
    ["admin_suspend_user", { p_user: A.id, p_reason: "test", p_until: null }],
  ]) {
    const r = await rpc(Y, fn, args);
    ok(`a member calling ${fn} is refused by the database`, refused(r), String(r.status));
  }
  let r = await rpc(Y, "admin_active_users", { p_since: new Date().toISOString() });
  ok("the internal activity counter can't be called at all", r.status >= 400, String(r.status));
  const yPage = await phone(Y);
  await yPage.goto(`${BASE}/admin`, { waitUntil: "networkidle" });
  ok("a member opening /admin sees “doesn't exist”", await yPage.getByText("This page doesn't exist").isVisible().catch(() => false));

  // ---------------------------------------------------- wait for the operator's grant
  console.log(`WAITING for admin grant: amigo-e2e-${ADMIN_NONCE}-admin@example.com`);
  let granted = false;
  for (let i = 0; i < 60 && !granted; i++) {
    granted = (await rpc(A, "is_admin")).data === true;
    if (!granted) await sleep(5000);
  }
  ok("the temporary admin was granted admin rights", granted);
  if (!granted) throw new Error("no admin grant");

  // ---------------------------------------------------- admin API
  r = await rpc(A, "admin_insights");
  const m = r.data ?? {};
  ok("admin_insights answers", r.status === 200 && typeof m.users === "number", String(r.status));
  ok("…numbers are consistent (users ≥ new in 7 days ≥ new today; MAU ≥ WAU ≥ DAU)", m.users >= m.new_users_7d && m.new_users_7d >= m.new_users_today && m.mau >= m.wau && m.wau >= m.dau, JSON.stringify({ users: m.users, n7: m.new_users_7d, today: m.new_users_today, dau: m.dau, wau: m.wau, mau: m.mau }));
  ok("…14 days of trend data", Array.isArray(m.daily) && m.daily.length === 14);
  ok("…includes the two new test accounts in today's signups", m.new_users_today >= 2, String(m.new_users_today));
  r = await rpc(A, "admin_user_search", { p_query: yHandle });
  ok("search finds the member by handle", r.data?.[0]?.id === Y.id, String(r.status));
  r = await rpc(A, "admin_user_search", { p_query: "%" });
  ok("a search for “%” is literal, not a wildcard", Array.isArray(r.data) && r.data.every((u) => u.username.includes("%") || u.display_name.includes("%")), String(r.data?.length));
  r = await rpc(A, "admin_user_detail", { p_user: Y.id });
  ok("account detail loads", r.data?.id === Y.id && r.data?.suspension === null, String(r.status));
  ok("…and contains no email address", !JSON.stringify(r.data).includes("@example.com"));
  r = await rpc(A, "admin_add_note", { p_target_type: "user", p_target: Y.id, p_note: "Automated test note" });
  ok("an admin adds a note", r.status === 200 || r.status === 204, String(r.status));
  r = await rpc(A, "admin_add_note", { p_target_type: "user", p_target: Y.id, p_note: "   " });
  ok("an empty note is refused", r.status >= 400, String(r.status));
  r = await rpc(A, "admin_target_history", { p_target: Y.id });
  ok("the note shows in the account's history", r.data?.some?.((h) => h.action === "note" && h.summary === "Automated test note"), String(r.status));

  // ---------------------------------------------------- admin UI
  const aPage = await phone(A);
  await aPage.goto(`${BASE}/admin`, { waitUntil: "networkidle" });
  await aPage.getByRole("heading", { name: "Platform" }).waitFor();
  await aPage.locator(".admin-stats__item").first().waitFor();
  ok("Overview shows the platform metrics", (await aPage.locator(".admin-stats__item").count()) >= 15);
  ok("Overview shows the 14-day charts", (await aPage.locator(".admin-chart").count()) === 3);
  await shot("overview-metrics", aPage.locator("section", { has: aPage.getByRole("heading", { name: "Platform" }) }));
  await shot("overview-trend", aPage.locator("section", { has: aPage.getByRole("heading", { name: "Last 14 days" }) }));

  await aPage.goto(`${BASE}/admin/users?u=${encodeURIComponent(yHandle)}`, { waitUntil: "networkidle" });
  await aPage.locator(".admin-account__detail").waitFor();
  ok("Users opens the member's account from a link", (await aPage.locator(".admin-account__detail").count()) === 1);
  await aPage.locator(".admin-account__detail input[placeholder^='Reason']").fill("Automated test: suspension check");
  await aPage.locator(".admin-account__detail").getByRole("button", { name: "Suspend" }).click();
  await aPage.locator(".admin-badge--danger").waitFor();
  ok("suspend (after confirming) marks the account Suspended", await aPage.locator(".admin-badge--danger").isVisible());
  await shot("users-suspended", aPage.locator("section", { has: aPage.getByRole("heading", { name: "Accounts" }) }));
  r = await rpc(Y, "create_post", { p_body: `Suspended post ${tag}`, p_media: [] });
  ok("the database refuses a post from the suspended account", r.status >= 400, `${r.status} ${typeof r.data === "object" ? r.data?.message?.slice(0, 80) : ""}`);
  await aPage.locator(".admin-account__detail").getByRole("button", { name: "Restore account" }).click();
  await aPage.locator(".admin-badge--danger").waitFor({ state: "detached" });
  ok("restore (after confirming) clears the suspension", (await aPage.locator(".admin-badge--danger").count()) === 0);
  r = await rpc(Y, "create_post", { p_body: `Restored post ${tag}`, p_media: [] });
  ok("the restored account can post again", r.status === 200, String(r.status));
  r = await rpc(A, "admin_target_history", { p_target: Y.id });
  ok("history records the suspension and the restore", r.data?.length >= 3, JSON.stringify(r.data?.map?.((h) => h.action)));
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
console.log(failures ? `${failures} FAILED` : "ALL ADMIN TESTS PASSED");
process.exit(failures ? 1 : 0);
