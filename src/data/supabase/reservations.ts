import type { ReservationSettings, ReservationsAdminApi, UsernameReservation, UsernamesApi } from "../types";
import { dataError, type Db } from "./queries";

// UR001 protected, UR002 reserved, UR003 bad name, UR004 taken, UR008 email not confirmed, UR009 not found.
const MESSAGES: Record<string, string> = {
  UR001: "That username isn't available.",
  UR002: "That username is reserved.",
  UR003: "Usernames are 3–24 letters, numbers or _.",
  UR004: "Another account has that username.",
  UR008: "Confirm your email address first.",
  UR009: "That reservation isn't there any more.",
};

/** Turns a username-rule refusal into a readable error (keeps the code for callers). */
export function usernameError(e: { code?: string; message?: string } | null): Error {
  const code = e?.code ?? "";
  if (MESSAGES[code]) return Object.assign(new Error(MESSAGES[code]), { code: "invalid-argument", pgCode: code });
  return dataError(e as Error);
}

async function call<T>(db: Db, fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await db.rpc(fn as never, args as never);
  if (error) throw usernameError(error);
  return data as T;
}

type Row = {
  id: string; username: string; email: string; status: UsernameReservation["status"]; created_at: string;
  verified_at: string | null; expires_at: string | null; claimed_username: string | null; closed_reason: string | null;
};

export function createReservationsAdminApi(db: Db): ReservationsAdminApi {
  return {
    async settings() {
      const s = await call<{ open: boolean; hold_days: number; max_per_email: number; active: number; claimed: number }>(db, "admin_reservation_settings");
      return { open: s.open, holdDays: s.hold_days, maxPerEmail: s.max_per_email, active: s.active, claimed: s.claimed } satisfies ReservationSettings;
    },
    setSettings: (open, holdDays, maxPerEmail) => call(db, "admin_set_reservation_settings", { p_open: open, p_hold_days: holdDays, p_max_per_email: maxPerEmail }),
    async list(status, query) {
      const rows = await call<Row[]>(db, "admin_reservations", { p_status: status, p_query: query });
      return rows.map((r) => ({
        id: r.id, username: r.username, email: r.email, status: r.status, createdAt: r.created_at, verifiedAt: r.verified_at,
        expiresAt: r.expires_at, claimedHandle: r.claimed_username, closedReason: r.closed_reason,
      }));
    },
    revoke: (id, reason) => call(db, "admin_revoke_reservation", { p_id: id, p_reason: reason }),
    extend: (id, days) => call<string>(db, "admin_extend_reservation", { p_id: id, p_days: days }),
    protectedNames: () => call(db, "admin_protected_usernames"),
    protect: (name, note) => call(db, "admin_protect_username", { p_name: name, p_note: note }),
    unprotect: (name) => call(db, "admin_unprotect_username", { p_name: name }),
    assign: (userId, name, reason) => call(db, "admin_set_username", { p_user: userId, p_name: name, p_reason: reason }),
  };
}

export function createUsernamesApi(db: Db): UsernamesApi {
  return {
    async mine() {
      const rows = await call<{ id: string; username: string; expires_at: string }[]>(db, "my_reservations");
      return rows.map((r) => ({ id: r.id, username: r.username, expiresAt: r.expires_at }));
    },
    claim: (id) => call<string>(db, "claim_reserved_username", { p_reservation: id }),
  };
}

/** Free for this account to take? Checks profiles, protected names and reservations in one go. */
export const usernameAvailable = (db: Db, name: string) => call<boolean>(db, "username_available", { p_name: name.toLowerCase() });
