import { useEffect, useState } from "react";
import { dataSource } from "../../data";
import { useViewer } from "../../state/session";

export const adminEnabled = !!dataSource.admin;
const cache = new Map<string, boolean>();

/**
 * Whether the viewer is an Amigo admin, as reported by the backend. This only
 * decides what the UI shows; every admin operation is authorised again by the
 * backend (Supabase: is_admin() inside each admin RPC).
 */
export function useIsAdmin(): boolean | null {
  const viewer = useViewer();
  const [admin, setAdmin] = useState<boolean | null>(() => cache.get(viewer.id) ?? null);
  useEffect(() => {
    if (!dataSource.admin) return setAdmin(false);
    let cancelled = false;
    dataSource.admin
      .isAdmin(viewer.id)
      .then((v) => {
        cache.set(viewer.id, v);
        if (!cancelled) setAdmin(v);
      })
      .catch(() => !cancelled && setAdmin(false));
    return () => {
      cancelled = true;
    };
  }, [viewer.id]);
  return admin;
}
