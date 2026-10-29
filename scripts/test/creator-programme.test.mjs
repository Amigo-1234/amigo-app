/**
 * Creator Programme (migration 20261021090000) through PostgREST as real users:
 * applications (validation, one active at a time, closed programme), the
 * review workflow (more information requested → resubmit → reject with reason →
 * reapply → approve), permissions (members can't review, read others'
 * applications or feedback, or touch the tables), the creator dashboard figures
 * against known activity, private feedback with admin responses, revocation and
 * the audit log.
 *
 * LOCAL database only (it opens applications and grants a local admin):
 *   PGRST_URL=http://localhost:54331 JWT_SECRET=… DATABASE_URL=postgresql://…/amigo_neon \
 *     node scripts/test/creator-programme.test.mjs
 */
import { createHmac, randomUUID } from "node:crypto";
import pg from "pg";

const { PGRST_URL, JWT_SECRET, DATABASE_URL } = process.env;
if (!PGRST_URL || !JWT_SECRET || !DATABASE_URL) throw new Error("Set PGRST_URL, JWT_SECRET and DATABASE_URL");
if (!/localhost|127\.0\.0\.1/.test(DATABASE_URL)) throw new Error("Refusing to run against a non-local database");

let failures = 0;
const ok = (label, cond, extra = "") => {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
};
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (sub) => {
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ sub, role: "authenticated", aud: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600 });
  return `${head}.${body}.${createHmac("sha256", JWT_SECRET).update(`${head}.${body}`).digest("base64url")}`;
};
const call = async (who, path, init = {}) => {
  const res = await fetch(`${PGRST_URL}/${path}`, {
    ...init,
    headers: { authorization: `Bearer ${jwt(who.id)}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data, code: data?.code };
};
const rpc = (who, fn, args = {}) => call(who, `rpc/${fn}`, { method: "POST", body: JSON.stringify(args) });

const db = new pg.Client({ connectionString: DATABASE_URL });
await db.connect();
const tag = randomUUID().slice(0, 6);
const people = {};
for (const who of ["admin", "creator", "other"]) {
  const id = randomUUID();
  await db.query("insert into app_auth.users (id, email, email_confirmed_at) values ($1, $2, now())", [id, `cp-${tag}-${who}@example.test`]);
  await db.query("insert into public.profiles (id, username, display_name) values ($1, $2, $3) on conflict (id) do update set username = excluded.username", [id, `cp_${tag}_${who}`, `CP ${who}`]);
  people[who] = { id };
}
const { admin: A, creator: C, other: O } = people;
await db.query("insert into public.app_admins (user_id, note) values ($1, 'local test')", [A.id]);
const settings = (await db.query("select applications_open from public.monetization_settings")).rows[0];

const good = { p_category: "music", p_description: "I write and record acoustic songs every week.", p_reason: "I want to grow an audience that supports my music.", p_links: ["https://example.com/me"], p_extra: "" };

try {
  // ---------------------------------------------------------- closed programme
  await db.query("update public.monetization_settings set applications_open = false");
  let r = await rpc(C, "creator_apply", good);
  ok("applying while applications are closed is refused", r.code === "MN001", JSON.stringify(r.data).slice(0, 120));
  r = await rpc(C, "admin_monetization_settings_set", { p_programme_open: false, p_applications_open: true, p_criteria: {}, p_public_note: "" });
  ok("a member can't open applications", r.status >= 400 && r.code === "42501", String(r.code));
  r = await rpc(A, "admin_monetization_settings_set", { p_programme_open: false, p_applications_open: true, p_criteria: {}, p_public_note: "" });
  ok("an admin opens applications", r.status < 300, String(r.status));

  // ---------------------------------------------------------- application validation
  r = await rpc(C, "creator_apply", { ...good, p_category: "nonsense" });
  ok("an unknown category is refused", r.code === "CP001", r.code);
  r = await rpc(C, "creator_apply", { ...good, p_description: "too short" });
  ok("a too-short description is refused", r.code === "CP002", r.code);
  r = await rpc(C, "creator_apply", { ...good, p_links: ["javascript:alert(1)"] });
  ok("a non-https link is refused", r.code === "CP005", r.code);
  r = await rpc(C, "creator_apply", { ...good, p_links: Array(6).fill("https://example.com") });
  ok("more than 5 links are refused", r.code === "CP005", r.code);
  r = await rpc(C, "creator_apply", good);
  const appId = r.data;
  ok("a valid application is accepted", r.status === 200 && typeof appId === "string", JSON.stringify(r.data).slice(0, 80));
  r = await rpc(C, "creator_apply", good);
  ok("a second active application is refused", r.code === "MN003", r.code);

  // ---------------------------------------------------------- privacy & permissions
  r = await rpc(C, "my_creator_programme");
  ok("the applicant sees their application as pending", r.data?.application?.status === "pending" && r.data?.application?.category === "music", r.data?.application?.status);
  ok("…and is not yet a creator (no dashboard figures)", r.data?.creator_status === "not_eligible" && r.data?.stats === null);
  r = await rpc(O, "my_creator_programme");
  ok("another member doesn't see it", r.data?.application === null);
  r = await call(O, "creator_applications?select=id");
  ok("members can't read the applications table", r.status >= 400, String(r.status));
  r = await call(O, `creator_applications?id=eq.${appId}`, { method: "PATCH", body: JSON.stringify({ status: "approved" }) });
  ok("members can't change an application's status directly", r.status >= 400, String(r.status));
  r = await call(C, "creator_monetization_status", { method: "POST", body: JSON.stringify({ user_id: C.id, status: "eligible" }) });
  ok("a member can't make themselves a creator", r.status >= 400, String(r.status));
  r = await rpc(C, "admin_creator_application_decide", { p_application: appId, p_decision: "approved", p_note: "" });
  ok("an applicant can't approve their own application", r.code === "42501", r.code);
  r = await rpc(O, "admin_creator_applications_v2", { p_status: "all", p_query: "" });
  ok("a member can't list applications", r.code === "42501", r.code);

  // ---------------------------------------------------------- review workflow
  r = await rpc(A, "admin_creator_applications_v2", { p_status: "pending", p_query: `cp_${tag}` });
  ok("the admin sees the pending application with its details", r.data?.[0]?.id === appId && r.data[0].reason.startsWith("I want") && r.data[0].links[0] === "https://example.com/me");
  r = await rpc(A, "admin_creator_application_decide", { p_application: appId, p_decision: "info_requested", p_note: "" });
  ok("asking for more information needs a note", r.code === "SP006", r.code);
  r = await rpc(A, "admin_creator_application_decide", { p_application: appId, p_decision: "info_requested", p_note: "Please add a link to your recordings." });
  ok("the admin asks for more information", r.status < 300, String(r.status));
  r = await rpc(C, "my_creator_programme");
  ok("the applicant sees the request", r.data?.application?.status === "info_requested" && r.data.application.info_request.includes("recordings"));
  r = await rpc(C, "creator_application_update", { p_application: appId, ...good, p_links: ["https://example.com/me", "https://example.com/recordings"] });
  ok("the applicant answers and resubmits", r.status < 300 && (await rpc(C, "my_creator_programme")).data?.application?.status === "pending", JSON.stringify(r.data).slice(0, 80));
  r = await rpc(O, "creator_application_update", { p_application: appId, ...good });
  ok("someone else can't edit the application", r.code === "MN006", r.code);
  r = await rpc(A, "admin_creator_application_decide", { p_application: appId, p_decision: "rejected", p_note: "" });
  ok("rejecting needs an explanation", r.code === "SP006", r.code);
  r = await rpc(A, "admin_creator_application_decide", { p_application: appId, p_decision: "rejected", p_note: "Not enough recent posts yet." });
  ok("the admin rejects with an explanation", r.status < 300);
  r = await rpc(C, "my_creator_programme");
  ok("the applicant sees the rejection and reason", r.data?.application?.status === "rejected" && r.data.application.review_note === "Not enough recent posts yet.");
  r = await rpc(A, "admin_creator_application_decide", { p_application: appId, p_decision: "approved", p_note: "" });
  ok("a decided application can't be decided again", r.code === "SP005", r.code);

  // Some real activity for the dashboard: two posts by the creator, one like and one reply from someone else.
  const idOf = (d) => (typeof d === "string" ? d : d?.id);
  const p1 = idOf((await rpc(C, "create_post", { p_body: "First song", p_media: [] })).data);
  await rpc(C, "create_post", { p_body: "Second song", p_media: [] });
  const liked = await rpc(O, "set_post_like", { p_post_id: p1, p_liked: true });
  const replied = await rpc(O, "create_post", { p_body: "Love it", p_parent_id: p1, p_media: [] });
  ok("setup: another member likes and replies to the creator's post", liked.status < 300 && replied.status < 300, `${liked.status} ${JSON.stringify(liked.data).slice(0, 100)} / ${replied.status} ${JSON.stringify(replied.data).slice(0, 100)}`);
  await call(O, "follows", { method: "POST", body: JSON.stringify({ follower_id: O.id, followee_id: C.id }) });

  r = await rpc(C, "creator_apply", good);
  const app2 = r.data;
  ok("after a rejection the creator can apply again", r.status === 200, JSON.stringify(r.data).slice(0, 80));
  r = await rpc(A, "admin_creator_application_decide", { p_application: app2, p_decision: "approved", p_note: "" });
  ok("the admin approves", r.status < 300, JSON.stringify(r.data).slice(0, 80));
  r = await rpc(C, "my_creator_programme");
  const s = r.data?.stats;
  ok("the creator is approved", r.data?.creator_status === "eligible" && r.data.application.status === "approved");
  ok("dashboard: 2 posts, 1 like and 1 reply received, 1 follower (all real)", s?.posts === 2 && s.likes_received === 1 && s.replies_received === 1 && s.followers === 1 && s.verified_followers === 1, JSON.stringify(s && { p: s.posts, l: s.likes_received, r: s.replies_received, f: s.followers, vf: s.verified_followers }));
  const thisWeek = s?.weekly?.at(-1);
  ok("dashboard: this week's trend counts the same activity (8 weeks)", s?.weekly?.length === 8 && thisWeek.posts === 2 && thisWeek.likes === 1 && thisWeek.replies === 1, JSON.stringify(thisWeek));
  ok("dashboard: recent posts with their counts", s?.recent_posts?.length === 2 && s.recent_posts.some((p) => p.id === p1 && p.likes === 1 && p.replies === 1));
  r = await rpc(C, "creator_apply", good);
  ok("an approved creator can't apply again", r.code === "MN004", r.code);

  // ---------------------------------------------------------- feedback
  r = await rpc(O, "creator_feedback_submit", { p_category: "features", p_rating: 4, p_body: "I am not a creator but here goes." });
  ok("non-members can't send creator feedback", r.code === "CP010", r.code);
  r = await rpc(C, "creator_feedback_submit", { p_category: "features", p_rating: 9, p_body: "Rating out of range." });
  ok("a rating outside 1–5 is refused", r.code === "CP012", r.code);
  r = await rpc(C, "creator_feedback_submit", { p_category: "features", p_rating: 4, p_body: "The dashboard is useful; weekly trends help." });
  const fb = r.data;
  ok("the creator sends feedback", r.status === 200 && typeof fb === "string");
  r = await rpc(O, "my_creator_feedback");
  ok("another member sees none of it", Array.isArray(r.data) && r.data.length === 0);
  r = await call(O, "creator_feedback?select=body");
  ok("members can't read the feedback table", r.status >= 400, String(r.status));
  r = await rpc(O, "admin_creator_feedback", { p_status: "all" });
  ok("members can't open the feedback inbox", r.code === "42501", r.code);
  r = await rpc(A, "admin_creator_feedback", { p_status: "open" });
  ok("the admin sees it in the inbox", r.data?.some?.((f) => f.id === fb && f.rating === 4));
  r = await rpc(A, "admin_creator_feedback_update", { p_feedback: fb, p_status: "resolved", p_response: "Thanks — more charts are coming." });
  ok("the admin responds and resolves it", r.status < 300);
  r = await rpc(C, "my_creator_feedback");
  ok("the creator sees the response", r.data?.[0]?.status === "resolved" && r.data[0].admin_response.startsWith("Thanks"));

  // ---------------------------------------------------------- revoke
  r = await rpc(O, "admin_monetization_status_set", { p_user: C.id, p_status: "revoked", p_reason: "test" });
  ok("a member can't revoke anyone", r.code === "42501", r.code);
  r = await rpc(A, "admin_monetization_status_set", { p_user: C.id, p_status: "revoked", p_reason: "Engagement manipulation found." });
  ok("the admin revokes the approval", r.status < 300);
  r = await rpc(C, "my_creator_programme");
  ok("the creator sees it's revoked, with the reason, and no dashboard", r.data?.creator_status === "revoked" && r.data.creator_reason.includes("manipulation") && r.data.stats === null);
  r = await rpc(C, "creator_apply", good);
  ok("a revoked creator can't reapply", r.code === "MN002", r.code);

  // ---------------------------------------------------------- audit
  const log = (await db.query("select action, summary from public.admin_audit_log where target_id = $1 or target_id = $2 order by created_at", [C.id, fb])).rows;
  ok("every decision is in the audit log", ["creator.application", "creator.feedback", "monetization.status"].every((a) => log.some((l) => l.action === a)) && log.filter((l) => l.action === "creator.application").length === 3, log.map((l) => l.action).join(", "));
  ok("…without the feedback text", !log.some((l) => l.summary.includes("weekly trends")));
} catch (e) {
  failures++;
  console.log(`FAIL stopped: ${e.message}`);
} finally {
  await db.query("update public.monetization_settings set applications_open = $1", [settings.applications_open]);
  await db.query("delete from public.admin_audit_log where target_id = any($1)", [Object.values(people).map((p) => p.id)]);
  for (const p of Object.values(people)) {
    await db.query("delete from public.profiles where id = $1", [p.id]);
    await db.query("delete from app_auth.users where id = $1", [p.id]);
  }
  await db.end();
}
console.log(failures ? `${failures} FAILED` : "ALL CREATOR PROGRAMME TESTS PASSED");
process.exit(failures ? 1 : 0);
