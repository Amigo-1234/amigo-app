/**
 * The loader talks to Auth and Storage through these small ports, so the
 * same migration runs against a real Supabase project (Admin API + Storage
 * API) or against a local Postgres for testing (SQL + filesystem).
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type pg from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface NewAuthUser {
  email: string;
  emailConfirmed: boolean;
  displayName: string | null;
  firebaseUid: string;
  placeholder: boolean;
  banned: boolean;
}

export interface AuthPort {
  createUser(u: NewAuthUser): Promise<string>;
}

export interface StoragePort {
  put(bucket: string, path: string, bytes: Buffer, contentType: string): Promise<void>;
  get(bucket: string, path: string): Promise<Buffer | null>;
}

// ------------------------------------------------------------ real Supabase

export class SupabaseAdminAuth implements AuthPort {
  private client: SupabaseClient;
  constructor(client: SupabaseClient) {
    this.client = client;
  }
  async createUser(u: NewAuthUser): Promise<string> {
    const { data, error } = await this.client.auth.admin.createUser({
      email: u.email,
      email_confirm: u.emailConfirmed,
      // No password: Firebase scrypt hashes cannot be imported. People set a
      // new one by proving their old password (legacy-sign-in) or by reset.
      user_metadata: { display_name: u.displayName ?? undefined },
      app_metadata: { legacy_firebase_uid: u.firebaseUid, legacy_placeholder: u.placeholder || undefined },
      ban_duration: u.banned ? "876000h" : undefined,
    });
    if (error || !data.user) throw new Error(`createUser failed: ${error?.message ?? "no user returned"}`);
    return data.user.id;
  }
}

export class SupabaseStorage implements StoragePort {
  private client: SupabaseClient;
  constructor(client: SupabaseClient) {
    this.client = client;
  }
  async put(bucket: string, path: string, bytes: Buffer, contentType: string) {
    const { error } = await this.client.storage.from(bucket).upload(path, bytes, { contentType, upsert: true, cacheControl: "31536000" });
    if (error) throw new Error(`upload ${bucket}/${path} failed: ${error.message}`);
  }
  async get(bucket: string, path: string) {
    const { data, error } = await this.client.storage.from(bucket).download(path);
    if (error || !data) return null;
    return Buffer.from(await data.arrayBuffer());
  }
}

// ------------------------------------------------- local testing (no Supabase)

/** Inserts straight into auth.users of the local shim. Never use on a real project. */
export class LocalSqlAuth implements AuthPort {
  private db: pg.Client;
  constructor(db: pg.Client) {
    this.db = db;
  }
  async createUser(u: NewAuthUser): Promise<string> {
    const { rows } = await this.db.query(
      `insert into auth.users (email, email_confirmed_at, raw_user_meta_data, raw_app_meta_data)
       values ($1, case when $2 then now() end, $3, $4) returning id`,
      [u.email, u.emailConfirmed, { display_name: u.displayName }, { legacy_firebase_uid: u.firebaseUid, legacy_placeholder: u.placeholder }],
    );
    return rows[0].id;
  }
}

export class LocalFsStorage implements StoragePort {
  private root: string;
  constructor(root: string) {
    this.root = root;
  }
  async put(bucket: string, path: string, bytes: Buffer) {
    const file = join(this.root, bucket, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, bytes);
  }
  async get(bucket: string, path: string) {
    const file = join(this.root, bucket, path);
    return existsSync(file) ? readFileSync(file) : null;
  }
}
