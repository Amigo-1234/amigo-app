/**
 * Media service (api/media-upload.ts, api/media.ts) against a local PostgREST
 * on the Neon-built schema and a local S3 emulator (moto) standing in for R2.
 *
 *   PGRST_URL=http://localhost:54331 JWT_SECRET=… DATABASE_URL=…/amigo_neon S3_URL=http://localhost:54340 \
 *     node scripts/test/media.test.mjs
 *
 * Checks the authorization flow end to end. Signature enforcement (exact type
 * and size on PUT, expiry) is R2's job and isn't checked by the emulator.
 */
import { createHmac, randomUUID } from "node:crypto";
import pg from "pg";
import { createServer } from "vite";
import { AwsClient } from "aws4fetch";
import { createClient } from "@supabase/supabase-js";

const { PGRST_URL, JWT_SECRET, DATABASE_URL, S3_URL } = process.env;
if (!PGRST_URL || !JWT_SECRET || !DATABASE_URL || !S3_URL) throw new Error("Set PGRST_URL, JWT_SECRET, DATABASE_URL, S3_URL");
Object.assign(process.env, {
  NEON_REST_URL_OVERRIDE: PGRST_URL,
  R2_ACCOUNT_ID: "test", R2_ACCESS_KEY_ID: "test", R2_SECRET_ACCESS_KEY: "test", R2_BUCKET: "amigo-media",
  R2_ENDPOINT_OVERRIDE: `${S3_URL}/amigo-media`,
});
const s3 = new AwsClient({ accessKeyId: "test", secretAccessKey: "test", service: "s3", region: "us-east-1" });
await s3.fetch(`${S3_URL}/amigo-media`, { method: "PUT" });

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (sub) => {
  const h = b64({ alg: "HS256", typ: "JWT" }), b = b64({ exp: Math.floor(Date.now() / 1000) + 3600, sub, role: "authenticated" });
  return `${h}.${b}.${createHmac("sha256", JWT_SECRET).update(`${h}.${b}`).digest("base64url")}`;
};
const vite = await createServer({ server: { middlewareMode: true }, appType: "custom", logLevel: "error" });
const upload = (await vite.ssrLoadModule("/api/media-upload.ts")).default;
const media = (await vite.ssrLoadModule("/api/media.ts")).default;
const signFn = (await vite.ssrLoadModule("/api/media-sign.ts")).default;
const db = new pg.Client({ connectionString: DATABASE_URL });
await db.connect();

let failures = 0;
const ok = (label, cond, extra = "") => {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
};
const ask = (token, body) => upload(new Request("http://app.test/api/media-upload", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) }));
const read = (token, key, jsonMode = false) => media(new Request(`http://app.test/api/media?path=${encodeURIComponent(key)}${jsonMode ? "&json=1" : ""}`, { headers: token ? { authorization: `Bearer ${token}` } : {} }));

const ids = { a: randomUUID(), b: randomUUID(), c: randomUUID() };
try {
  for (const [n, id] of Object.entries(ids)) await db.query("insert into app_auth.users (id, email, email_confirmed_at) values ($1, $2, now())", [id, `media-${n}-${id.slice(0, 6)}@example.com`]);
  const [A, B, C] = [jwt(ids.a), jwt(ids.b), jwt(ids.c)];
  const photo = Buffer.from("fake-jpeg-bytes-".repeat(64));

  // upload a post photo
  let r = await ask(A, { purpose: "post", mime: "image/jpeg", size: photo.length });
  const up = await r.json();
  ok("upload link issued for an allowed file", r.status === 200 && up.key?.startsWith(`${ids.a}/post/`) && up.url?.includes("X-Amz-Signature"));
  ok("link signs type and size", /X-Amz-SignedHeaders=[^&]*content-length[^&]*content-type/.test(up.url) && /X-Amz-Expires=600/.test(up.url));
  const put = await fetch(up.url, { method: "PUT", headers: { "content-type": "image/jpeg" }, body: photo });
  ok("browser-style PUT stores the file", put.ok, String(put.status));

  r = await ask(A, { purpose: "post", mime: "text/html", size: 10 });
  ok("disallowed type refused", r.status === 403);
  r = await ask(A, { purpose: "post", mime: "image/jpeg", size: 50 * 1024 * 1024 });
  ok("oversized file refused", r.status === 403);
  r = await upload(new Request("http://app.test/api/media-upload", { method: "POST", body: "{}" }));
  ok("signed-out upload refused", r.status === 401);

  // before attaching: only the owner can read it
  r = await read(B, up.key);
  ok("someone else can't read an unattached upload", r.status === 404);
  r = await read(A, up.key);
  ok("owner gets a redirect to a signed link", r.status === 302 && r.headers.get("location")?.includes("X-Amz-Signature") && r.headers.get("cache-control")?.startsWith("private"));
  const got = await fetch(r.headers.get("location"));
  ok("signed link returns the bytes", Buffer.compare(Buffer.from(await got.arrayBuffer()), photo) === 0);

  // attach to a followers-only post: B (not following) can't, after following can
  const createAs = async (uid, sql, params) => {
    await db.query("begin");
    await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: uid, role: "authenticated" })]);
    await db.query("set local role authenticated");
    const res = await db.query(sql, params);
    await db.query("commit");
    return res;
  };
  await createAs(ids.a, "select public.create_post('photo post', null, $1::jsonb, 'followers')", [JSON.stringify([{ kind: "image", storage_path: up.key, mime_type: "image/jpeg", width: 10, height: 10, byte_size: photo.length }])]);
  r = await read(B, up.key);
  ok("followers-only post photo hidden from non-followers", r.status === 404);
  await createAs(ids.b, "insert into public.follows (follower_id, followee_id) values ($1, $2)", [ids.b, ids.a]);
  r = await read(B, up.key, true);
  ok("visible once following (json mode for fetch)", r.status === 200 && (await r.json()).url?.includes("X-Amz-Signature"));
  r = await read(null, up.key);
  ok("signed-out read refused", r.status === 401);
  r = await read(B, "../etc/passwd");
  ok("malformed keys rejected", r.status === 404);

  // the smaller copy: same owner only, readable exactly when the original is
  const sign = (token, keys) => signFn(new Request("http://app.test/api/media-sign", { method: "POST", headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" }, body: JSON.stringify({ keys }) }));
  const smallBytes = Buffer.from("small-webp-".repeat(16));
  r = await ask(C, { variantOf: up.key, mime: "image/webp", size: smallBytes.length });
  ok("someone else can't add a smaller copy to your photo", r.status === 403);
  r = await ask(A, { variantOf: up.key, mime: "image/webp", size: smallBytes.length });
  const sm = await r.json();
  ok("owner gets an upload link for the smaller copy", r.status === 200 && sm.key === up.key.replace(/\.jpg$/, "-sm.webp"), sm.key);
  await fetch(sm.url, { method: "PUT", headers: { "content-type": "image/webp" }, body: smallBytes });
  r = await ask(A, { variantOf: up.key, mime: "image/webp", size: smallBytes.length });
  ok("only one smaller copy per photo", r.status === 403);
  r = await ask(A, { variantOf: up.key, mime: "image/webp", size: 3 * 1024 * 1024 });
  ok("oversized smaller copy refused", r.status === 403);
  r = await media(new Request(`http://app.test/api/media?path=${encodeURIComponent(up.key)}&size=sm`, { headers: { authorization: `Bearer ${B}` } }));
  ok("?size=sm redirects a follower to the smaller copy", r.status === 302 && r.headers.get("location")?.includes("-sm.webp"));
  r = await read(B, sm.key);
  ok("the smaller copy is readable by a follower", r.status === 302);
  r = await read(C, sm.key);
  ok("…and hidden from a non-follower like the original", r.status === 404);
  r = await media(new Request(`http://app.test/api/media?path=${encodeURIComponent(up.key)}&size=sm`, { headers: { authorization: `Bearer ${C}` } }));
  ok("?size=sm hidden from a non-follower", r.status === 404);

  // signing many at once
  r = await sign(B, [up.key, `${ids.a}/post/${"0".repeat(32)}.jpg`]);
  let signed = await r.json();
  ok("batch signing returns links for visible files with their smaller copy", r.status === 200 && signed.links[up.key]?.url?.includes("X-Amz-Signature") && signed.links[up.key]?.small?.includes("-sm.webp") && signed.ttl > 3000);
  ok("files that don't exist are left out", Object.keys(signed.links).length === 1);
  const again = await (await sign(B, [up.key])).json();
  ok("signing again in the same window gives the identical link (browser cache hit)", again.links[up.key]?.url === signed.links[up.key].url && again.links[up.key]?.small === signed.links[up.key].small);
  ok("links ask the browser to keep the bytes privately", new URL(signed.links[up.key].url).searchParams.get("response-cache-control") === "private, max-age=5400, immutable");
  const viaLink = await fetch(signed.links[up.key].small);
  ok("the signed small link returns the smaller copy", Buffer.compare(Buffer.from(await viaLink.arrayBuffer()), smallBytes) === 0);
  r = await sign(C, [up.key]);
  signed = await r.json();
  ok("batch signing leaves out files you may not see", r.status === 200 && Object.keys(signed.links).length === 0);
  ok("batch signing needs a sign-in", (await sign(null, [up.key])).status === 401);
  ok("batch signing rejects malformed keys", (await sign(B, ["../x", 5])).status === 400);
  r = await sign(A, Array.from({ length: 80 }, () => `${ids.a}/post/${randomUUID().replace(/-/g, "")}.jpg`).concat(up.key));
  ok("batch signing handles a long list (capped)", r.status === 200);

  // encrypted DM attachment
  const conv = randomUUID();
  await db.query("insert into public.dm_conversations (id, direct_key) values ($1, $2)", [conv, `${ids.a}:${ids.b}`]);
  await db.query("insert into public.dm_participants (conversation_id, user_id) values ($1, $2), ($1, $3)", [conv, ids.a, ids.b]);
  r = await ask(A, { purpose: "dm", mime: "application/octet-stream", size: 100, conversationId: conv });
  const dm = await r.json();
  ok("encrypted DM upload link for a participant", r.status === 200 && dm.key.includes(`/dm/${conv}/`));
  r = await ask(C, { purpose: "dm", mime: "application/octet-stream", size: 100, conversationId: conv });
  ok("outsider can't upload into a conversation", r.status === 403);
  ok("other participant can read it", (await read(B, dm.key, true)).status === 200);
  ok("outsider can't read it", (await read(C, dm.key, true)).status === 404);

  // deletion → queue → removed from storage on a later upload call
  await fetch((await (await ask(A, { purpose: "moment", mime: "image/png", size: 4 })).json()).url, { method: "PUT", headers: { "content-type": "image/png" }, body: Buffer.from("wxyz") });
  const { rows: pend } = await db.query("select path from public.media_objects where owner_id = $1 and purpose = 'moment' order by created_at desc limit 1", [ids.a]);
  const momentKey = pend[0].path;
  await createAs(ids.a, "select public.create_moment('', 'coral', $1, 10, 10, 'everyone')", [momentKey]);
  ok("Moment photo readable by others while live", (await read(B, momentKey)).status === 302);
  await createAs(ids.a, "select public.delete_moment(id) from public.moments where author_id = $1", [ids.a]);
  ok("deleted Moment's photo no longer readable", (await read(B, momentKey)).status === 404);
  await ask(A, { purpose: "post", mime: "image/jpeg", size: 10 }); // drains the queue
  const head = await s3.fetch(`${S3_URL}/amigo-media/${momentKey}`, { method: "HEAD" });
  ok("deleted Moment's file removed from storage", head.status === 404, String(head.status));

  // Encrypted photo message, end to end: the app's own messaging code with a
  // media store that calls the two functions directly.
  const { createSupabaseMessages } = await vite.ssrLoadModule("/src/data/supabase/messages.ts");
  const storeFor = (token) => ({
    async upload(purpose, blob, opts = {}) {
      const res = await ask(token, { purpose, mime: "application/octet-stream", size: blob.size, conversationId: opts.conversationId });
      const { key, url } = await res.json();
      const p = await fetch(url, { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: Buffer.from(await blob.arrayBuffer()) });
      if (!p.ok) throw new Error("put failed");
      return key;
    },
    url: (key) => `/api/media/${key}`,
    async bytes(key) {
      const r = await read(token, key, true);
      if (r.status !== 200) throw new Error("refused " + r.status);
      return new Uint8Array(await (await fetch((await r.json()).url)).arrayBuffer());
    },
  });
  const fetchRewrite = (u, o) => fetch(String(u).replace("/rest/v1", ""), o);
  const client = (token) => createClient(PGRST_URL, "x", { auth: { persistSession: false }, global: { fetch: fetchRewrite, headers: { Authorization: `Bearer ${token}` } } });
  const once = (_n, f, sub) => { f().then(sub.onData, sub.onError); return () => {}; };
  const appA = createSupabaseMessages(client(A), once, () => {}, { memoryStore: true, realtime: false, media: storeFor(A) });
  const appB = createSupabaseMessages(client(B), once, () => {}, { memoryStore: true, realtime: false, media: storeFor(B) });
  ok("message photos enabled with the media service", appA.photos === true);
  await appA.security.setup(ids.a);
  await appB.security.setup(ids.b);
  const dmConv = await appA.openConversation(ids.a, ids.b);
  const pixels = new Uint8Array(512).map((_, i) => i % 251);
  await appA.send(ids.a, dmConv, { text: "photo!", image: { kind: "image", blob: new Blob([pixels], { type: "image/png" }), width: 16, height: 16 } });
  // The conversation shows at once (photo as a placeholder), then again once the photo is decrypted.
  const views = [];
  const viewB = await new Promise((res, rej) => {
    const stop = appB.subscribeConversation(dmConv, ids.b, {
      onData: (v) => {
        views.push(v);
        if (v.messages.at(-1)?.media[0]?.url) {
          stop();
          res(v);
        }
      },
      onError: rej,
    });
    setTimeout(() => rej(new Error("photo never finished loading")), 30000);
  });
  ok("the conversation shows before its photo has loaded", views.length >= 2 && views[0].messages.at(-1)?.media[0]?.url === "", String(views.length));
  const msg = viewB.messages.at(-1);
  ok("recipient decrypts the photo message", msg?.text === "photo!" && msg.media.length === 1, JSON.stringify(msg?.media?.length));
  const blobUrl = msg?.media[0]?.url;
  const decrypted = blobUrl ? new Uint8Array(await (await fetch(blobUrl)).arrayBuffer()) : null;
  ok("decrypted bytes match the original", !!decrypted && Buffer.compare(Buffer.from(decrypted), Buffer.from(pixels)) === 0);
  const { rows: [stored] } = await db.query("select path from public.media_objects where conversation_id = $1 order by created_at desc limit 1", [dmConv]);
  const raw = Buffer.from(await (await s3.fetch(`${S3_URL}/amigo-media/${stored.path}`)).arrayBuffer());
  ok("the bucket holds ciphertext, not the photo", raw.length > 0 && Buffer.compare(raw, Buffer.from(pixels)) !== 0 && !raw.includes(Buffer.from(pixels.slice(0, 64))));
} catch (e) {
  console.error(e);
  failures++;
} finally {
  await db.query("delete from app_auth.users where id = any($1)", [Object.values(ids)]).catch(() => undefined);
  await db.end();
  await vite.close();
}
console.log(failures ? `${failures} FAILED` : "ALL MEDIA TESTS PASSED");
process.exit(failures ? 1 : 0);
