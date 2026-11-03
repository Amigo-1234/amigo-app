import { rpc } from "./_media";
import { sendPush, type PushOutcome, type Vapid } from "./_webpush";

/**
 * Pushes pending activity notifications. Postgres claims each one once,
 * re-checks it's still true and allowed (prefs, blocking, visibility), groups
 * bursts and rate-limits per target (push_activity_targets). The payload says
 * what kind, how many, who (display name) and where to open — never post text.
 * Returns how many pushes were delivered to push services.
 */
export async function sendActivityPushes(token: string, vapid: Vapid, serverKey: string): Promise<number> {
  type Target = {
    id: string;
    endpoint: string;
    p256dh: string;
    auth_secret: string;
    kind: string;
    post_id: string | null;
    request_id: string | null;
    on_reply: boolean;
    actor_name: string;
    n: number;
  };
  const targets = await rpc<Target[]>(token, "push_activity_targets", { p_key: serverKey });
  if (!targets.ok || !targets.data.length) return 0;
  const outcomes = await Promise.all(
    targets.data.map(async (t) => {
      const where = (t.post_id ?? t.request_id ?? "").replace(/-/g, "");
      const payload = { t: "act", k: t.kind, p: t.post_id, r: t.request_id, x: t.on_reply, a: t.actor_name, n: t.n };
      return {
        id: t.id,
        outcome: await sendPush(vapid, { endpoint: t.endpoint, p256dh: t.p256dh, auth: t.auth_secret }, payload, {
          // A newer push about the same thing replaces one still waiting at the push service.
          topic: `${t.kind.slice(0, 3)}${where}`.slice(0, 32),
          urgency: "normal",
          ttl: 24 * 3600,
        }).catch((): PushOutcome => "failed"),
      };
    }),
  );
  await rpc(token, "push_report", {
    p_key: serverKey,
    p_results: outcomes.map((o) => ({ id: o.id, ok: o.outcome === "ok", gone: o.outcome === "gone" })),
  });
  return outcomes.filter((o) => o.outcome === "ok").length;
}
