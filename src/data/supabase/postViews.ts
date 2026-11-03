/**
 * Post view counts on Neon (migration 20261104090000_post_views.sql). Recording and totals go
 * through two checked functions; who viewed what never leaves the database.
 */
import type { PostViewsApi } from "../types";
import { dataError, type Db } from "./queries";

async function call<T>(db: Db, fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await db.rpc(fn as never, args as never);
  if (error) throw dataError(error);
  return data as T;
}

export function createPostViewsApi(db: Db): PostViewsApi {
  return {
    async totals(postIds) {
      const r = await call<{ on: boolean; counts?: Record<string, number> }>(db, "post_view_totals", { p_posts: postIds });
      return { on: r.on, counts: new Map(Object.entries(r.counts ?? {})) };
    },
    record: async (postIds) => (await call<string[] | null>(db, "record_post_views", { p_posts: postIds })) ?? [],
    admin: {
      // Asked of the views function itself, so a database without the migration reads as
      // unavailable rather than "off" (its switch doesn't exist there to turn on).
      async status() {
        const { data, error } = await db.rpc("post_view_totals" as never, { p_posts: [] } as never);
        if (error) {
          if (error.code === "PGRST202" || error.code === "42883" || /could not find the function|does not exist/i.test(error.message)) return "unavailable";
          throw dataError(error);
        }
        return (data as { on: boolean }).on ? "on" : "off";
      },
      setEnabled: (enabled) => call(db, "admin_set_feature", { p_key: "post_views", p_enabled: enabled }),
    },
  };
}
