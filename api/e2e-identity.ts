/**
 * POST /api/e2e-identity  (Bearer JWT + the session cookie)
 *   { device, master, self_signing, user_signing }   (or { device, check: true }: only "is the sign-in fresh?")
 *
 * Replaces the account's encryption identity ("I can't use another device"). An
 * ordinary call can't (e2e_upload_signing_keys refuses a different key, DM014);
 * this one does it when:
 *   - the session behind the request was signed in within the last 10 minutes
 *     (asked of Neon Auth with the browser's own session cookie), so a stolen
 *     token or an old session can't;
 *   - the new keys hang together (self-signing and user-signing keys signed by
 *     the new master key);
 *   - the session's user is the token's user (checked in e2e_replace_identity).
 * It is recorded (Your devices shows it) and the account's email address is told,
 * so the owner hears about a reset they didn't make.
 */
import { json, NEON_AUTH, rpc } from "./_media";
import { verifyNewIdentity } from "../src/lib/e2eProof";

export const config = { runtime: "edge" };

const ENV = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
export const FRESH_SIGN_IN_MS = 10 * 60_000;

type Session = { session?: { userId?: string; createdAt?: string } | null; user?: { email?: string | null } | null } | null;

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== "POST") return json(405, { error: "method" });
  const secret = ENV.PUSH_SERVER_SECRET;
  if (!secret) return json(503, { error: "not-configured" });
  const auth = req.headers.get("authorization");
  const cookie = req.headers.get("cookie");
  if (!auth?.startsWith("Bearer ") || !cookie) return json(401, { error: "sign-in" });
  const token = auth.slice(7);

  const body = (await req.json().catch(() => null)) as { check?: boolean; device?: string; master?: unknown; self_signing?: unknown; user_signing?: unknown } | null;
  if (!body || typeof body.device !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(body.device)) return json(400, { error: "bad-request" });
  if (body.check !== true && (!body.master || !body.self_signing)) return json(400, { error: "bad-request" });

  const s = (await fetch(`${NEON_AUTH}/get-session`, { headers: { cookie, origin: new URL(req.url).origin } })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)) as Session;
  const userId = s?.session?.userId;
  const signedInAt = Date.parse(s?.session?.createdAt ?? "");
  if (!userId || !Number.isFinite(signedInAt)) return json(401, { error: "sign-in" });
  if (Date.now() - signedInAt > FRESH_SIGN_IN_MS) return json(401, { error: "reauth-required", code: "DM014" });

  // { check: true }: asked before new keys are made on the device, so a stale sign-in fails early.
  if (body.check === true) return json(200, { fresh: true });

  const user = `@${userId}:amigo.world`;
  if (!(await verifyNewIdentity(user, { master: body.master, self_signing: body.self_signing, user_signing: body.user_signing }))) return json(400, { error: "invalid-keys", code: "DM011" });

  const res = await rpc<null>(token, "e2e_replace_identity", {
    p_key: secret,
    p_session_user: userId,
    p_device: body.device,
    p_master: body.master,
    p_self_signing: body.self_signing,
    p_user_signing: body.user_signing ?? null,
  });
  if (!res.ok) return json(res.status === 401 ? 401 : 403, { error: "refused", code: res.code, message: res.message });

  await tellOwner(s?.user?.email ?? null).catch(() => undefined);
  return json(200, { replaced: true });
}

/** Best effort: the reset is done either way. Says only what happened; no links to follow. */
async function tellOwner(to: string | null) {
  const { RESEND_API_KEY, EMAIL_FROM } = ENV;
  if (!to || !RESEND_API_KEY || !EMAIL_FROM) return;
  const when = new Date().toUTCString();
  const text = [
    "Your Amigo World message security key was reset",
    "",
    `When: ${when}`,
    "",
    "Your other signed-in devices now need to be approved again, and people you've verified will see that your security key changed.",
    "",
    "If this was you, there's nothing else to do.",
    "If it wasn't, change your password now in Amigo World (Settings), then check Your devices and remove any you don't recognise.",
  ].join("\n");
  const html = `<p><strong>Your Amigo World message security key was reset</strong></p><p>When: ${when}</p>
<p>Your other signed-in devices now need to be approved again, and people you've verified will see that your security key changed.</p>
<p>If this was you, there's nothing else to do.<br>If it wasn't, change your password now in Amigo World (Settings), then check Your devices and remove any you don't recognise.</p>`;
  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ from: EMAIL_FROM, to: [to], subject: "Your message security key was reset", text, html, tags: [{ name: "kind", value: "identity_reset" }] }),
  });
}
