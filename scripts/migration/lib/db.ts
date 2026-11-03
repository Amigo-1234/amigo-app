/**
 * The migration's only database access: the service-role-only import API
 * (supabase/migrations/*_legacy_import_api.sql) called over HTTPS through the
 * Data API. Works anywhere HTTPS works — no direct Postgres connection needed.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export class MigrationDb {
  private client: SupabaseClient;
  constructor(client: SupabaseClient) {
    this.client = client;
  }

  async rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
    const { data, error } = await this.client.rpc(fn, args);
    if (error) throw new Error(`${fn} failed: ${error.message}${error.code ? ` (${error.code})` : ""}`);
    return data as T;
  }

  state() {
    return this.rpc<{ users: Record<string, string>; posts: Record<string, string>; media: string[] }>("legacy_state");
  }
}
