import { dataSource } from "../../data";

/** Profiles are an optional backend capability; without it, names render as plain text. */
export const profilesEnabled = !!dataSource.profiles;

export function profileHref(handle: string): string | null {
  return profilesEnabled ? `/u/${handle}` : null;
}
