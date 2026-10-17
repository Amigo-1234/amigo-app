/**
 * Live media test against the deployed preview (Vercel functions + Neon + the
 * real Cloudflare R2 bucket). Runs in GitHub Actions (.github/workflows/live-media.yml).
 *
 *   BASE=https://<preview> VERCEL_BYPASS=<protection bypass secret> node scripts/test/live-media.test.mjs
 *
 * Creates three temporary accounts (amigo-e2e-<run>-{a,b,c}@example.com) and
 * deletes them at the end through the app's own account deletion (which
 * removes their files too). Prints no secrets, tokens or signed URLs.
 */
import { randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { createServer } from "vite";

const { BASE, VERCEL_BYPASS } = process.env;
if (!BASE || !VERCEL_BYPASS) throw new Error("Set BASE and VERCEL_BYPASS");
const BYPASS = { "x-vercel-protection-bypass": VERCEL_BYPASS };

let failures = 0;
const ok = (label, cond, extra = "") => {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
};

// ---------------------------------------------------------------- accounts

async function account(tag, who) {
  const email = `amigo-e2e-${tag}-${who}@example.com`;
  const password = randomBytes(18).toString("base64url");
  const res = await fetch(`${BASE}/neon/auth/sign-up/email`, {
    method: "POST",
    headers: { ...BYPASS, origin: BASE, "content-type": "application/json" },
    body: JSON.stringify({ email, password, name: `Media Test ${who.toUpperCase()}` }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`sign-up ${who}: ${res.status}`);
  const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const t = await fetch(`${BASE}/neon/auth/token`, { headers: { ...BYPASS, origin: BASE, cookie } });
  const { token } = await t.json();
  return { id: body.user.id, token, cookie };
}

const rpc = async (who, fn, args = {}) => {
  const res = await fetch(`${BASE}/neon/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { ...BYPASS, authorization: `Bearer ${who.token}`, "content-type": "application/json" },
    body: JSON.stringify(args),
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
};

// ------------------------------------------------------------------- media

async function begin(who, purpose, mime, size, conversationId) {
  const res = await fetch(`${BASE}/api/media-upload`, {
    method: "POST",
    headers: { ...BYPASS, authorization: `Bearer ${who.token}`, "content-type": "application/json" },
    body: JSON.stringify({ purpose, mime, size, conversationId: conversationId ?? null }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function upload(who, purpose, mime, bytes, conversationId) {
  const b = await begin(who, purpose, mime, bytes.length, conversationId);
  if (b.status !== 200) throw new Error(`begin ${purpose}: ${b.status} ${b.body.error ?? ""}`);
  const put = await fetch(b.body.url, { method: "PUT", headers: { "content-type": mime }, body: bytes });
  if (!put.ok) throw new Error(`PUT ${purpose}: ${put.status}`);
  return b.body.key;
}

/** GET /api/media/<key> as someone (Bearer or cookie); returns status and, on 302, the bytes. */
async function read(who, key, { cookie = false, json = false } = {}) {
  const auth = !who ? {} : cookie ? { cookie: who.cookie } : { authorization: `Bearer ${who.token}` };
  const res = await fetch(`${BASE}/api/media/${key}${json ? "?json=1" : ""}`, { headers: { ...BYPASS, ...auth }, redirect: "manual" });
  const signed = res.status === 302 ? res.headers.get("location") : res.status === 200 && json ? (await res.json()).url : null;
  const file = signed ? await fetch(signed) : null;
  return { status: res.status, cache: res.headers.get("cache-control"), signed, bytes: file?.ok ? Buffer.from(await file.arrayBuffer()) : null, fileStatus: file?.status };
}

// -------------------------------------------------------------------- run

const tag = randomBytes(4).toString("hex");
const people = [];
/** Signed links to files the test created, checked after cleanup to prove the objects are gone from R2. */
const created = [];
try {
  const A = await account(tag, "a");
  people.push(A);
  const B = await account(tag, "b");
  people.push(B);
  const C = await account(tag, "c");
  people.push(C);
  ok("three temporary accounts signed up", !!(A.token && B.token && C.token));

  // --- uploads: validation and signature enforcement (real R2)
  const jpeg = randomBytes(4096);
  let b = await begin(A, "post", "image/jpeg", jpeg.length);
  ok("upload link issued (storage configured)", b.status === 200 && !!b.body.key, `${b.status} ${b.body.error ?? ""} ${b.body.message ?? ""}`);
  if (b.status !== 200) {
    // Diagnose: the same database call made directly through the Data API proxy.
    const d = await rpc(A, "media_begin_upload", { p_purpose: "post", p_mime: "image/jpeg", p_size: jpeg.length, p_conversation: null });
    console.log(`diag: direct media_begin_upload → ${d.status} ${d.data?.code ?? ""} ${d.data?.message ?? (typeof d.data === "string" ? "key" : "")}`);
    const REST = "https://ep-dry-mode-zano9y8g.apirest.c-2.eu-west-2.aws.neon.tech/neondb/rest/v1";
    for (const [label, extra] of [["no origin", {}], ["with origin", { origin: BASE }], ["accept json", { accept: "application/json" }]]) {
      const x = await fetch(`${REST}/rpc/media_begin_upload`, {
        method: "POST",
        headers: { authorization: `Bearer ${A.token}`, "content-type": "application/json", ...extra },
        body: JSON.stringify({ p_purpose: "post", p_mime: "image/jpeg", p_size: 10, p_conversation: null }),
      });
      const t = await x.text();
      console.log(`diag: Neon direct (${label}) → ${x.status} ${x.ok ? "key" : t.slice(0, 120)}`);
    }
    const again = await begin(A, "post", "image/jpeg", jpeg.length);
    console.log(`diag: upload function again → ${again.status} ${again.body.error ?? ""}`);
    const me = await rpc(A, "my_account_status");
    console.log(`diag: my_account_status → ${me.status} ${JSON.stringify(me.data).slice(0, 120)}`);
  }
  const wrongType = await fetch(b.body.url, { method: "PUT", headers: { "content-type": "text/html" }, body: jpeg });
  ok("R2 refuses a different content type than signed", wrongType.status === 403, String(wrongType.status));
  const wrongSize = await fetch(b.body.url, { method: "PUT", headers: { "content-type": "image/jpeg" }, body: randomBytes(4097) });
  ok("R2 refuses a different size than signed", wrongSize.status === 403, String(wrongSize.status));
  const put = await fetch(b.body.url, { method: "PUT", headers: { "content-type": "image/jpeg" }, body: jpeg });
  ok("upload to the real bucket succeeds", put.ok, String(put.status));
  const postKey = b.body.key;
  ok("disallowed type refused", (await begin(A, "post", "text/html", 10)).status === 403);
  ok("oversized file refused", (await begin(A, "post", "image/jpeg", 20 * 1024 * 1024)).status === 403);

  // --- bucket is private
  const unsigned = new URL(b.body.url);
  unsigned.search = "";
  const anon = await fetch(unsigned);
  ok("bucket is private (unsigned GET refused)", anon.status === 400 || anon.status === 401 || anon.status === 403, String(anon.status));

  // --- reads follow the content's visibility
  ok("others can't read an unattached upload", (await read(B, postKey)).status === 404);
  let r = await read(A, postKey);
  if (r.signed) created.push(r.signed);
  ok("owner reads it back from R2 (bytes match)", r.status === 302 && r.bytes?.equals(jpeg) && r.cache?.startsWith("private"));
  const followersPost = await rpc(A, "create_post", { p_body: "followers-only photo", p_media: [{ kind: "image", storage_path: postKey, mime_type: "image/jpeg", width: 8, height: 8, byte_size: jpeg.length }], p_visibility: "followers" });
  ok("photo post created", followersPost.status === 200, String(followersPost.status));
  ok("followers-only photo hidden from non-followers", (await read(B, postKey)).status === 404);
  await fetch(`${BASE}/neon/rest/v1/follows`, { method: "POST", headers: { ...BYPASS, authorization: `Bearer ${B.token}`, "content-type": "application/json" }, body: JSON.stringify({ follower_id: B.id, followee_id: A.id }) });
  r = await read(B, postKey, { cookie: true });
  ok("visible once following, via session cookie (<img> path)", r.status === 302 && r.bytes?.equals(jpeg));
  ok("signed-out read refused", (await read(null, postKey)).status === 401);
  const reuse = await rpc(B, "create_post", { p_body: "steal", p_media: [{ kind: "image", storage_path: postKey, mime_type: "image/jpeg" }] });
  ok("someone else's upload can't be attached", reuse.status >= 400);

  // --- avatar
  const avatarBytes = randomBytes(2048);
  const avatarKey = await upload(A, "avatar", "image/webp", avatarBytes);
  const patch = await fetch(`${BASE}/neon/rest/v1/profiles?id=eq.${A.id}`, {
    method: "PATCH",
    headers: { ...BYPASS, authorization: `Bearer ${A.token}`, "content-type": "application/json" },
    body: JSON.stringify({ avatar_url: `/api/media/${avatarKey}` }),
  });
  ok("avatar saved on the profile", patch.ok, String(patch.status));
  r = await read(C, avatarKey, { cookie: true });
  if (r.signed) created.push(r.signed);
  ok("avatar visible to other members", r.status === 302 && r.bytes?.equals(avatarBytes));

  // --- Moment photo: visible while live, gone after delete, file removed from R2
  const momentBytes = randomBytes(1024);
  const momentKey = await upload(A, "moment", "image/png", momentBytes);
  const mom = await rpc(A, "create_moment", { p_body: "", p_background: "coral", p_media_path: momentKey, p_media_width: 8, p_media_height: 8, p_audience: "everyone" });
  ok("photo Moment created", mom.status === 200, String(mom.status));
  r = await read(C, momentKey, { json: true });
  ok("Moment photo visible to others while live", r.status === 200 && r.bytes?.equals(momentBytes));
  const heldLink = r.signed;
  await rpc(A, "delete_moment", { p_moment: mom.data });
  ok("deleted Moment's photo no longer served", (await read(C, momentKey)).status === 404);
  await begin(A, "post", "image/jpeg", 10); // drains the deletion queue
  const after = heldLink ? await fetch(heldLink) : null;
  ok("deleted Moment's file removed from R2 (an old link now 404s)", after?.status === 404, String(after?.status));

  // --- encrypted DM photo, end to end with the app's own messaging code
  const vite = await createServer({ server: { middlewareMode: true }, appType: "custom", logLevel: "error" });
  try {
    const { createSupabaseMessages } = await vite.ssrLoadModule("/src/data/supabase/messages.ts");
    const db = (who) => createClient(BASE, "neon", {
      auth: { persistSession: false },
      global: { headers: { ...BYPASS, Authorization: `Bearer ${who.token}` }, fetch: (u, o) => fetch(String(u).replace(`${BASE}/rest/v1`, `${BASE}/neon/rest/v1`), o) },
    });
    const store = (who) => ({
      upload: async (purpose, blob, opts = {}) => upload(who, purpose, "application/octet-stream", Buffer.from(await blob.arrayBuffer()), opts.conversationId),
      url: (key) => `/api/media/${key}`,
      bytes: async (key) => {
        const x = await read(who, key, { json: true });
        if (!x.bytes) throw new Error(`refused ${x.status}`);
        return new Uint8Array(x.bytes);
      },
    });
    const once = (_n, f, sub) => {
      f().then(sub.onData, sub.onError);
      return () => {};
    };
    const appA = createSupabaseMessages(db(A), once, () => {}, { memoryStore: true, realtime: false, media: store(A) });
    const appB = createSupabaseMessages(db(B), once, () => {}, { memoryStore: true, realtime: false, media: store(B) });
    await appA.security.setup(A.id);
    await appB.security.setup(B.id);
    const conv = await appA.openConversation(A.id, B.id);
    const pixels = randomBytes(3000);
    await appA.send(A.id, conv, { text: "live photo", image: { kind: "image", blob: new Blob([pixels], { type: "image/png" }), width: 8, height: 8 } });
    const view = await new Promise((res, rej) => appB.subscribeConversation(conv, B.id, { onData: res, onError: rej }));
    const msg = view.messages.at(-1);
    const got = msg?.media[0]?.url ? Buffer.from(await (await fetch(msg.media[0].url)).arrayBuffer()) : null;
    ok("encrypted DM photo: recipient decrypts the original", msg?.text === "live photo" && got?.equals(pixels));
    const keyRow = await fetch(`${BASE}/neon/rest/v1/dm_messages?conversation_id=eq.${conv}&select=content&order=created_at.desc&limit=1`, { headers: { ...BYPASS, authorization: `Bearer ${A.token}` } });
    ok("message row holds ciphertext only", JSON.stringify(await keyRow.json()).includes("m.megolm.v1.aes-sha2"));
    const dmUp = await begin(A, "dm", "application/octet-stream", 100, conv);
    ok("participant may upload into the conversation", dmUp.status === 200);
    ok("outsider can't upload into it", (await begin(C, "dm", "application/octet-stream", 100, conv)).status === 403);
    ok("plaintext type refused for DM uploads", (await begin(A, "dm", "image/png", 100, conv)).status === 403);
  } finally {
    await vite.close();
  }
} catch (e) {
  console.error("error:", e.message);
  failures++;
} finally {
  // Remove the temporary accounts through the app's own deletion. Their files are
  // queued for removal; the last account's upload calls drain the queue from R2.
  const drainer = people.at(-1);
  const del = async (p) => {
    const d = await rpc(p, "delete_my_account", { p_confirm: "DELETE" }).catch(() => ({ status: 0 }));
    const done = d.status === 200 || d.status === 204;
    if (!done) failures++;
    console.log(`cleanup: temporary account ${done ? "deleted" : `NOT deleted (${d.status}) id=${p.id}`}`);
  };
  for (const p of people.slice(0, -1)) await del(p);
  if (drainer) {
    for (let i = 0; i < 4; i++) await begin(drainer, "post", "image/jpeg", 1).catch(() => undefined);
    const gone = await Promise.all(created.map((u) => fetch(u).then((x) => x.status, () => 0)));
    ok("cleanup: test files removed from R2", gone.every((st) => st === 404), gone.join(","));
    await del(drainer);
  }
}
console.log(failures ? `${failures} FAILED` : "ALL LIVE MEDIA TESTS PASSED");
process.exit(failures ? 1 : 0);
