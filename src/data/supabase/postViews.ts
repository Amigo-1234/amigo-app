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
      enabled: async () => (await call<string[]>(db, "enabled_features")).includes("post_views"),
      setEnabled: (enabled) => call(db, "admin_set_feature", { p_key: "post_views", p_enabled: enabled }),
    },
  };
}
