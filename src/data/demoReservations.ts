import type { ReservationSettings, ReservationsAdminApi, UsernameReservation } from "./types";

/**
 * Username reservations for the demo: an in-memory copy of the admin side, so
 * the admin screen can be tried without a database. The real rules live in
 * supabase/migrations/20261103090000_username_reservations.sql.
 */
export function createDemoReservations(handleTaken: (name: string) => boolean): ReservationsAdminApi {
  const daysFromNow = (d: number) => new Date(Date.now() + d * 864e5).toISOString();
  const settings: Omit<ReservationSettings, "active" | "claimed"> = { open: false, holdDays: 180, maxPerEmail: 1 };
  const rows: UsernameReservation[] = [
    { id: "r1", username: "chioma_designs", email: "chioma@example.com", status: "active", createdAt: daysFromNow(-3), verifiedAt: daysFromNow(-3), expiresAt: daysFromNow(177), claimedHandle: null, closedReason: null },
    { id: "r2", username: "tunde_beats", email: "tunde@example.com", status: "active", createdAt: daysFromNow(-160), verifiedAt: daysFromNow(-160), expiresAt: daysFromNow(20), claimedHandle: null, closedReason: null },
    { id: "r3", username: "lagos_eats", email: "kemi@example.com", status: "pending", createdAt: daysFromNow(0), verifiedAt: null, expiresAt: null, claimedHandle: null, closedReason: null },
    { id: "r4", username: "naija_news", email: "spam@example.com", status: "revoked", createdAt: daysFromNow(-9), verifiedAt: daysFromNow(-9), expiresAt: daysFromNow(171), claimedHandle: null, closedReason: "Impersonating a news outlet" },
  ];
  const protectedNames = new Map<string, string | null>(["amigo", "admin", "support", "help", "official", "security", "staff"].map((n) => [n, "system or brand name"]));
  const NAME = /^[a-z0-9_]{3,24}$/;
  const later = <T,>(v: T) => new Promise<T>((r) => setTimeout(() => r(v), 150));
  const live = (r: UsernameReservation) => r.status === "pending" || r.status === "active";

  return {
    settings: () =>
      later({ ...settings, active: rows.filter((r) => r.status === "active").length, claimed: rows.filter((r) => r.status === "claimed").length }),
    async setSettings(open, holdDays, maxPerEmail) {
      if (!(holdDays >= 7 && holdDays <= 730) || !(maxPerEmail >= 1 && maxPerEmail <= 5)) throw new Error("Hold 7–730 days; 1–5 names per email.");
      Object.assign(settings, { open, holdDays, maxPerEmail });
      await later(null);
    },
    list(status, query) {
      const q = query.toLowerCase();
      return later(
        rows
          .filter((r) => status === "all" || (status === "live" ? live(r) : r.status === status))
          .filter((r) => !q || r.username.includes(q) || r.email.includes(q))
          .map((r) => ({ ...r })),
      );
    },
    async revoke(id, reason) {
      if (reason.trim().length < 3) throw new Error("Give a reason.");
      const r = rows.find((x) => x.id === id && live(x));
      if (!r) throw new Error("That reservation isn't there any more.");
      Object.assign(r, { status: "revoked", closedReason: reason.trim() });
      await later(null);
    },
    async extend(id, days) {
      const r = rows.find((x) => x.id === id && x.status === "active");
      if (!r) throw new Error("That reservation isn't there any more.");
      r.expiresAt = new Date(Math.max(Date.parse(r.expiresAt!), Date.now()) + days * 864e5).toISOString();
      return later(r.expiresAt);
    },
    protectedNames: () => later([...protectedNames].sort(([a], [b]) => a.localeCompare(b)).map(([username, note]) => ({ username, note }))),
    async protect(name, note) {
      const n = name.trim().toLowerCase();
      if (!/^[a-z0-9_]{1,24}$/.test(n)) throw new Error("Not a username.");
      protectedNames.set(n, note.trim() || null);
      await later(null);
    },
    async unprotect(name) {
      if (!protectedNames.delete(name)) throw new Error("Not protected.");
      await later(null);
    },
    async assign(_userId, name, reason) {
      const n = name.trim().toLowerCase();
      if (!NAME.test(n)) throw new Error("Usernames are 3–24 letters, numbers or _.");
      if (reason.trim().length < 3) throw new Error("Give a reason.");
      if (handleTaken(n)) throw new Error("Another account has that username.");
      for (const r of rows) if (r.username === n && live(r)) Object.assign(r, { status: "revoked", closedReason: `given to an account by Amigo: ${reason.trim()}` });
      await later(null);
    },
  };
}
