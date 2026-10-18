/**
 * POST /api/worlds-tick  (Bearer JWT)
 * Any signed-in app calls this every few minutes. Postgres turns Worlds that
 * have started into "it's live" notices for their members (worlds_tick,
 * idempotent), then this server pushes every fresh World notice once
 * (live or cancelled) to members who allow World notifications. So Worlds go
 * live and members hear about it without an admin or a scheduler online; the
 * delay is at most the time until the next app asks.
 */
import { json, rpc } from "./_media";
import { sendPush, type PushOutcome } from "./_webpush";

export const config = { runtime: "edge" };

const ENV = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== "POST") return json(405, { error: "method" });
  const auth = req.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) return json(401, { error: "sign-in" });
  const token = auth.slice(7);

  const started = await rpc<string[]>(token, "worlds_tick", {});
  if (!started.ok) return json(started.status === 401 ? 401 : 502, { error: "refused" });

  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT, PUSH_SERVER_SECRET } = ENV;
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY || !VAPID_SUBJECT || !PUSH_SERVER_SECRET) return json(200, { started: started.data.length, pushed: 0 });

  type Target = { world_id: string; slug: string; title: string; kind: "live" | "cancelled"; id: string; endpoint: string; p256dh: string; auth_secret: string };
  const targets = await rpc<Target[]>(token, "world_push_targets", { p_key: PUSH_SERVER_SECRET });
  if (!targets.ok || !targets.data.length) return json(200, { started: started.data.length, pushed: 0 });

  const vapid = { publicKey: VAPID_PUBLIC_KEY, privateKey: VAPID_PRIVATE_KEY, subject: VAPID_SUBJECT };
  const outcomes = await Promise.all(
    targets.data.map(async (t) => ({
      id: t.id,
      // World titles are public; nothing private is in this push.
      outcome: await sendPush(vapid, { endpoint: t.endpoint, p256dh: t.p256dh, auth: t.auth_secret }, { t: "world", k: t.kind, s: t.slug, n: t.title.slice(0, 80) }, {
        topic: `w${t.world_id.replace(/-/g, "").slice(0, 31)}`,
        urgency: "normal",
        ttl: 3 * 3600,
      }).catch((): PushOutcome => "failed"),
    })),
  );
  await rpc(token, "push_report", {
    p_key: PUSH_SERVER_SECRET,
    p_results: outcomes.map((o) => ({ id: o.id, ok: o.outcome === "ok", gone: o.outcome === "gone" })),
  });
  return json(200, { started: started.data.length, pushed: outcomes.filter((o) => o.outcome === "ok").length });
}
