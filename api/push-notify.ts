/**
 * POST /api/push-notify  { conversationId } | { test: true }  (Bearer JWT)
 * Called by the sender's app right after a new direct message. Postgres
 * decides who (if anyone) gets a push (push_message_targets: only after a
 * real new message from the caller, never to someone who blocked them or
 * turned message pushes off, at most one per conversation every 15 seconds)
 * and only answers this server. Each device gets an encrypted push saying
 * there is a new message and in which conversation — never its text, the
 * sender's name or any key. Dead subscriptions are removed.
 * { test: true } sends "notifications work" to the caller's own devices
 * (Settings → Send a test notification; at most every 20 seconds).
 *
 * Environment: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT, PUSH_SERVER_SECRET.
 */
import { json, rpc } from "./_media";
import { sendPush, type PushOutcome, type Vapid } from "./_webpush";

export const config = { runtime: "edge" };

const ENV = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== "POST") return json(405, { error: "method" });
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT, PUSH_SERVER_SECRET } = ENV;
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY || !VAPID_SUBJECT || !PUSH_SERVER_SECRET) return json(503, { error: "push-not-configured" });
  const auth = req.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) return json(401, { error: "sign-in" });
  const body = (await req.json().catch(() => null)) as { conversationId?: string; test?: boolean } | null;
  const test = body?.test === true;
  const conversation = body?.conversationId ?? "";
  if (!test && !UUID.test(conversation)) return json(400, { error: "bad-request" });

  type Target = { id: string; endpoint: string; p256dh: string; auth_secret: string };
  const targets = test
    ? await rpc<Target[]>(auth.slice(7), "push_self_targets", { p_key: PUSH_SERVER_SECRET })
    : await rpc<Target[]>(auth.slice(7), "push_message_targets", { p_key: PUSH_SERVER_SECRET, p_conversation: conversation });
  if (!targets.ok) return json(targets.status === 401 ? 401 : 403, { error: "refused" });
  if (!targets.data.length) return json(200, { sent: 0 });

  const vapid: Vapid = { publicKey: VAPID_PUBLIC_KEY, privateKey: VAPID_PRIVATE_KEY, subject: VAPID_SUBJECT };
  const payload = test ? { t: "test" } : { t: "dm", c: conversation };
  const outcomes = await Promise.all(
    targets.data.map(async (t) => ({
      id: t.id,
      outcome: await sendPush(vapid, { endpoint: t.endpoint, p256dh: t.p256dh, auth: t.auth_secret }, payload, {
        topic: test ? "test" : conversation.replace(/-/g, ""),
        urgency: "high",
      }).catch((): PushOutcome => "failed"),
    })),
  );
  await rpc(auth.slice(7), "push_report", {
    p_key: PUSH_SERVER_SECRET,
    p_results: outcomes.map((o) => ({ id: o.id, ok: o.outcome === "ok", gone: o.outcome === "gone" })),
  });
  return json(200, { sent: outcomes.filter((o) => o.outcome === "ok").length });
}
