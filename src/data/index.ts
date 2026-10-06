import type { DataSource } from "./types";

/**
 * Which backend the app talks to. Resolved at build time, so each build only
 * bundles the SDK it uses.
 *
 *   VITE_DATA_SOURCE=supabase   the new backend
 *   VITE_DATA_SOURCE=firebase   legacy — kept as the rollback path until cutover is final
 *   VITE_DATA_SOURCE=demo       in-memory demo data for UI work
 *
 * Unset means firebase, so nothing changes in production until the cutover
 * sets it explicitly.
 */
const source = import.meta.env.VITE_DATA_SOURCE ?? "firebase";

export const dataSource: DataSource =
  source === "demo"
    ? (await import("./demoSource")).demoSource
    : source === "supabase"
      ? (await import("./supabaseSource")).supabaseSource
      : (await import("./firebaseSource")).firebaseSource;

export type * from "./types";
export { AuthError, BIO_MAX_LENGTH, HANDLE_PATTERN, MESSAGE_MAX_LENGTH, MessageError, SecurityError, NAME_MAX_LENGTH, POST_MAX_LENGTH, ProfileError, SUPPORT_LIMITS, SupportError, WORLD_CHAT_MAX_LENGTH, WorldError } from "./types";
