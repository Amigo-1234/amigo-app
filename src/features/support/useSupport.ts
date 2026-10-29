import { useCallback, useEffect, useState } from "react";
import { dataSource, SupportError, type SupportCategory, type SupportConfig, type SupportRequest, type SupportSection, type SupportWallet } from "../../data";
import { useViewer } from "../../state/session";

export const supportEnabled = !!dataSource.support;

/** Wallet (credits/reputation). Refetches when `version` changes (after the viewer acts). */
export function useWallet(version: unknown) {
  const viewer = useViewer();
  const [wallet, setWallet] = useState<SupportWallet | null>(null);
  useEffect(() => {
    let cancelled = false;
    dataSource.support!.wallet(viewer.id).then((w) => !cancelled && setWallet(w)).catch(() => !cancelled && setWallet(null));
    return () => {
      cancelled = true;
    };
  }, [viewer.id, version]);
  return wallet;
}

export function useSupportConfig() {
  const [config, setConfig] = useState<SupportConfig | null>(null);
  useEffect(() => {
    void dataSource.support!.config().then(setConfig);
  }, []);
  return config;
}

type Load<T> = { status: "loading" } | { status: "ready"; data: T } | { status: "error"; error: unknown };

const PAGE = 12;

export function useSupportRequests(section: SupportSection, category: SupportCategory | null, query: string) {
  const viewer = useViewer();
  const [limit, setLimit] = useState(PAGE);
  const [state, setState] = useState<Load<{ requests: SupportRequest[]; hasMore: boolean }>>({ status: "loading" });
  const [key, setKey] = useState(0);
  useEffect(() => setLimit(PAGE), [section, category, query]);
  useEffect(() => {
    setState((s) => (s.status === "ready" ? s : { status: "loading" }));
    return dataSource.support!.subscribeRequests(viewer.id, { section, category, query, limit }, {
      onData: (data) => setState({ status: "ready", data }),
      onError: (error) => setState({ status: "error", error }),
    });
  }, [viewer.id, section, category, query, limit, key]);
  return {
    state,
    loadMore: useCallback(() => setLimit((l) => l + PAGE), []),
    retry: useCallback(() => {
      setState({ status: "loading" });
      setKey((k) => k + 1);
    }, []),
  };
}

export function useSupportRequest(id: string) {
  const viewer = useViewer();
  const [state, setState] = useState<Load<SupportRequest | null>>({ status: "loading" });
  const [key, setKey] = useState(0);
  useEffect(() => {
    setState({ status: "loading" });
    return dataSource.support!.subscribeRequest(id, viewer.id, {
      onData: (data) => setState({ status: "ready", data }),
      onError: (error) => setState({ status: "error", error }),
    });
  }, [id, viewer.id, key]);
  return { state, retry: () => setKey((k) => k + 1) };
}

export function supportErrorText(e: unknown): string {
  if (e instanceof SupportError) {
    switch (e.code) {
      case "insufficient-credits":
        return "You don't have enough Support Credits yet. Support someone else's request to earn more.";
      case "own-request":
        return "You can't support your own request.";
      case "already-supported":
        return "You've already done this.";
      case "not-opened":
        return "Open the link first, then come back to confirm.";
      case "too-fast":
        return "Take a moment with it first, then confirm.";
      case "not-active":
        return "This request isn't open for support right now.";
      case "already-reported":
        return "You've already reported this request.";
      case "not-admin":
        return "Admins only.";
      case "invalid":
        return e.message && e.message !== "invalid" ? e.message : "Check the details and try again.";
    }
  }
  return "Something went wrong. Try again.";
}
