/**
 * Web Push devices and preferences (migration 20261019110000). The server
 * sends pushes itself (api/push-notify.ts); the app only registers this
 * device, lists your devices and saves what you want to be notified about.
 */
import type { NotificationPrefs, PushApi, PushDevice } from "../types";
import type { Db } from "./queries";

const DEFAULT_PREFS: NotificationPrefs = { messages: true, worlds: true, social: false };

export function createPushApi(db: Db): PushApi {
  async function rpc(fn: string, args: Record<string, unknown>) {
    const { error } = await db.rpc(fn as never, args as never);
    if (error) throw new Error(error.message);
  }
  let publicKey: Promise<string | null> | null = null;
  return {
    publicKey() {
      publicKey ??= fetch("/api/push-config")
        .then((r) => (r.ok ? r.json() : null))
        .then((b: { publicKey?: string } | null) => b?.publicKey ?? null)
        .catch(() => {
          publicKey = null;
          return null;
        });
      return publicKey;
    },
    subscribe: (d) => rpc("push_subscribe", { p_endpoint: d.endpoint, p_p256dh: d.p256dh, p_auth: d.auth, p_label: d.label }),
    unsubscribe: (endpoint) => rpc("push_unsubscribe", { p_endpoint: endpoint }),
    async touch(endpoint) {
      const { data, error } = await db.rpc("push_touch" as never, { p_endpoint: endpoint } as never);
      if (error) throw new Error(error.message);
      return data === true;
    },
    async sendTest() {
      const token = (await db.auth.getSession()).data.session?.access_token;
      if (!token) return "failed";
      const res = await fetch("/api/push-notify", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ test: true }),
      }).catch(() => null);
      if (!res?.ok) return "failed";
      return ((await res.json()) as { sent: number }).sent ? "sent" : "wait";
    },
    async devices(viewerId) {
      const { data, error } = await db
        .from("push_subscriptions" as never)
        .select("id, label, created_at, last_seen_at, last_success_at")
        .eq("user_id", viewerId)
        .order("last_seen_at", { ascending: false });
      if (error) throw new Error(error.message);
      return ((data ?? []) as { id: string; label: string; created_at: string; last_seen_at: string; last_success_at: string | null }[]).map(
        (r): PushDevice => ({
          id: r.id,
          label: r.label,
          createdAt: new Date(r.created_at),
          lastSeenAt: new Date(r.last_seen_at),
          lastSuccessAt: r.last_success_at ? new Date(r.last_success_at) : null,
        }),
      );
    },
    removeDevice: (id) => rpc("push_remove_device", { p_id: id }),
    async prefs(viewerId) {
      const { data, error } = await db.from("notification_prefs" as never).select("push_messages, push_worlds, push_social").eq("user_id", viewerId).maybeSingle();
      if (error) throw new Error(error.message);
      const row = data as { push_messages: boolean; push_worlds: boolean; push_social: boolean } | null;
      return row ? { messages: row.push_messages, worlds: row.push_worlds, social: row.push_social } : DEFAULT_PREFS;
    },
    setPrefs: (p) => rpc("set_notification_prefs", { p_messages: p.messages ?? null, p_worlds: p.worlds ?? null, p_social: p.social ?? null }),
  };
}
