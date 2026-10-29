/**
 * Worlds additions (migration 20261019120000): admin management, World
 * notices, the server clock, and the "tick" that turns started Worlds into
 * notices (and pushes) without a scheduler or an admin being online.
 */
import { WorldError, type WorldInput, type WorldNotice, type WorldsAdminApi } from "../types";
import type { Db } from "./queries";

const ADMIN_ERRORS: Record<string, string> = {
  AW010: "That link is already used by another World.",
  AW013: "Finished or cancelled Worlds can't be changed.",
  AW014: "The start time, link and competition rules are fixed once a World has started.",
  AW015: "Times can't be moved into the past.",
  AW016: "That post isn't an entry in this World.",
  "42501": "Only Amigo admins can do that.",
};

async function rpc<T>(db: Db, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await db.rpc(fn as never, args as never);
  if (error) {
    const friendly = ADMIN_ERRORS[error.code ?? ""] ?? (error.code === "AW011" ? error.message.replace(/^check the World details: /, "Check the details: ") : null);
    throw new WorldError("unknown", friendly ?? error.message);
  }
  return data as T;
}

function toPayload(p: Partial<WorldInput>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (p.slug !== undefined) out.slug = p.slug.trim().toLowerCase();
  if (p.title !== undefined) out.title = p.title.trim();
  if (p.tagline !== undefined) out.tagline = p.tagline.trim();
  if (p.description !== undefined) out.description = p.description.trim();
  if (p.coverUrl !== undefined) out.coverUrl = p.coverUrl ?? "";
  if (p.startsAt) out.startsAt = p.startsAt.toISOString();
  if (p.endsAt) out.endsAt = p.endsAt.toISOString();
  if (p.competition !== undefined) {
    out.competition = !!p.competition;
    if (p.competition) {
      out.entriesCloseAt = p.competition.entriesCloseAt.toISOString();
      out.entryLimit = p.competition.entryLimit;
      out.pointsReaction = p.competition.scoring.reaction;
      out.pointsReply = p.competition.scoring.reply;
      out.pointsHostPick = p.competition.scoring.hostPick;
      out.prize = p.competition.prize ?? "";
    }
  }
  return out;
}

export function createWorldsAdmin(db: Db): WorldsAdminApi {
  return {
    async create(input) {
      return { id: await rpc<string>(db, "admin_create_world", { p: toPayload(input) }) };
    },
    update: (worldId, patch) => rpc(db, "admin_update_world", { p_id: worldId, p: toPayload(patch) }),
    async cancel(worldId, reason) {
      await rpc(db, "admin_cancel_world", { p_id: worldId, p_reason: reason });
      // Tell members now (push), not at the next routine tick.
      await worldsTick(db, true);
    },
    setHostPick: (worldId, postId, picked) => rpc(db, "admin_set_host_pick", { p_world: worldId, p_post: postId, p_picked: picked }),
    removeChatMessage: (messageId) => rpc(db, "admin_remove_world_chat", { p_message: messageId }),
    async picks(worldId) {
      const { data, error } = await db.from("world_host_picks").select("post_id").eq("world_id", worldId);
      if (error) throw new Error(error.message);
      return (data ?? []).map((r) => r.post_id);
    },
  };
}

export async function fetchWorldNotices(db: Db, viewerId: string): Promise<WorldNotice[]> {
  const { data, error } = await db
    .from("world_notices" as never)
    .select("id, kind, created_at, read_at, world:worlds(slug, title)")
    .eq("recipient_id", viewerId)
    .order("created_at", { ascending: false })
    .limit(30);
  if (error) throw new Error(error.message);
  return ((data ?? []) as { id: string; kind: "live" | "cancelled"; created_at: string; read_at: string | null; world: { slug: string; title: string } | null }[])
    .filter((r) => r.world)
    .map((r) => ({ id: r.id, kind: r.kind, world: r.world!, createdAt: new Date(r.created_at), read: !!r.read_at }));
}

export async function serverTime(db: Db): Promise<number> {
  const t0 = Date.now();
  const { data, error } = await db.rpc("server_now" as never);
  if (error) throw new Error(error.message);
  // Half the round trip: the moment the server read its clock, as best we can tell.
  return new Date(data as unknown as string).getTime() + (Date.now() - t0) / 2;
}

/** At most every few minutes per app; the server makes it idempotent and cheap. */
let lastTick = 0;
export async function worldsTick(db: Db, force = false): Promise<void> {
  if (!force && Date.now() - lastTick < 4 * 60_000) return;
  lastTick = Date.now();
  const token = (await db.auth.getSession()).data.session?.access_token;
  if (!token) return;
  await fetch("/api/worlds-tick", { method: "POST", headers: { authorization: `Bearer ${token}` }, keepalive: true }).catch(() => undefined);
}
