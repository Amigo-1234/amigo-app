/**
 * Privacy-safe performance reporting (see migration 20261018092000). Collects a
 * few timings — Core Web Vitals, how long the feed takes to appear, a sample of
 * API request times by endpoint name, uploads and message sends — and sends
 * them in small batches. Each sample is a metric name, a number, the route with
 * ids and handles removed, and the connection type the browser reports. Never
 * user ids, message content, tokens, query values or URLs; the server doesn't
 * link rows to people. At most MAX_PER_LOAD samples per page load.
 */
type Sample = { m: string; v: number; r: string; n: string };
type Sink = (samples: Sample[]) => Promise<void>;

const MAX_PER_LOAD = 150;
const BATCH = 40;
const API_SAMPLE_RATE = 0.2;

let sink: Sink | null = null;
let total = 0;
const queue: Sample[] = [];

/** "/u/ada/followers" → "/u/:handle/followers"; ids are also stripped on the server. */
export function routeTemplate(path = typeof location === "undefined" ? "" : location.pathname): string {
  return path
    .replace(/^\/u\/[^/]+/, "/u/:handle")
    .replace(/^\/(messages|post|support|worlds|legal|admin)\/[^/]+/, "/$1/:id")
    .slice(0, 120);
}

const connection = () => {
  const t = (navigator as Navigator & { connection?: { effectiveType?: string } }).connection?.effectiveType;
  return t === "slow-2g" || t === "2g" || t === "3g" || t === "4g" ? t : "unknown";
};

/** Record one timing (milliseconds, or a count/score). Never throws. */
export function track(metric: string, value: number) {
  if (!sink || total >= MAX_PER_LOAD || !Number.isFinite(value) || value < 0) return;
  total++;
  queue.push({ m: metric, v: Math.round(value * 100) / 100, r: routeTemplate(), n: connection() });
  if (queue.length >= BATCH) flush();
}

function flush() {
  if (!sink || !queue.length) return;
  const batch = queue.splice(0, BATCH);
  sink(batch).catch(() => undefined);
}

let once = new Set<string>();
/** Record a metric only the first time in this page load (e.g. "feed_ready"). */
export function trackOnce(metric: string, value: number) {
  if (once.has(metric)) return;
  once.add(metric);
  track(metric, value);
}

/** Which Data API endpoint a request went to (name only), or null for anything else. */
function apiEndpoint(url: string): string | null {
  const m = /\/rest\/v1\/(rpc\/)?([a-z0-9_]+)/.exec(url);
  // The reports themselves aren't measured.
  if (!m || m[2] === "log_client_perf" || m[2] === "log_client_error") return null;
  return `api:${m[1] ? "rpc" : "table"}:${m[2]}`;
}

export function installPerfReporting(report: Sink | undefined) {
  if (!report || typeof window === "undefined" || typeof PerformanceObserver === "undefined") return;
  sink = report;
  once = new Set();

  const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
  if (nav) track("ttfb", nav.responseStart);

  let lcp = 0;
  let cls = 0;
  let inp = 0;
  const observe = (type: string, cb: (entries: PerformanceEntryList) => void) => {
    try {
      new PerformanceObserver((list) => cb(list.getEntries())).observe({ type, buffered: true } as PerformanceObserverInit);
    } catch {
      /* not supported in this browser */
    }
  };
  observe("paint", (es) => es.forEach((e) => e.name === "first-contentful-paint" && track("fcp", e.startTime)));
  observe("largest-contentful-paint", (es) => (lcp = es[es.length - 1]?.startTime ?? lcp));
  observe("layout-shift", (es) => es.forEach((e) => !(e as unknown as { hadRecentInput: boolean }).hadRecentInput && (cls += (e as unknown as { value: number }).value)));
  // Interaction latency (an INP approximation): the slowest tap/keypress in this page load.
  observe("event", (es) => es.forEach((e) => (e as PerformanceEventTiming).interactionId && (inp = Math.max(inp, e.duration))));

  let finalSent = false;
  const final = () => {
    if (finalSent) return;
    finalSent = true;
    if (lcp) track("lcp", lcp);
    track("cls", cls * 1000); // ×1000: stored as a number like the others (0.1 → 100)
    if (inp) track("inp", inp);
  };
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      final();
      flush();
    }
  });
  setInterval(flush, 60_000);

  // A sample of API request times, by endpoint name only.
  const original = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const endpoint = Math.random() < API_SAMPLE_RATE ? apiEndpoint(url) : null;
    if (!endpoint) return original(input, init);
    const t0 = performance.now();
    try {
      const res = await original(input, init);
      track(res.ok ? endpoint : `${endpoint}:error`, performance.now() - t0);
      return res;
    } catch (e) {
      track(`${endpoint}:network_error`, performance.now() - t0);
      throw e;
    }
  };
}
