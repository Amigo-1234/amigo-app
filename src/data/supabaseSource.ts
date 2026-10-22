/**
 * Supabase implementation of the app's DataSource.
 *
 * Screens never import this file; they use the DataSource interface. All
 * reads go through RLS-protected tables or SECURITY INVOKER functions, and
 * all multi-row writes through the RPCs in supabase/migrations.
 *
 * Realtime: one channel per open feed/post, listening to `posts` changes
 * only. Likes and replies arrive as counter updates on the post row, so we
 * never subscribe to the likes firehose. Notifications listen to the
 * viewer's own `notifications` rows (Realtime applies RLS, so nobody receives
 * anyone else's).
 */
import type { AuthError as SupabaseAuthError, RealtimeChannel } from "@supabase/supabase-js";
import { isNeon, supabase } from "./supabase/client";
import { createSupabaseMessages } from "./supabase/messages";
import { createSupabaseMoments } from "./supabase/moments";
import { createModeration } from "./supabase/moderation";
import { createMediaStore } from "./supabase/mediaStore";
import { createPushApi } from "./supabase/push";
import * as worldsExtra from "./supabase/worldsExtra";
import { clearMediaCache, setMediaSigner } from "../lib/mediaLinks";
import { makePreview } from "../lib/image";
import { createPlatform } from "./supabase/platform";
import { cached, dropPrefetches, prefetch, remember, setCacheOwner, takePrefetch } from "./supabase/viewCache";
import * as q from "./supabase/queries";
import { announceSync } from "../lib/sync";
import { AuthError, INTERESTS, ProfileError, type AuthErrorCode, type DataSource, type FeedScope, type Interest, type Subscription, type Viewer } from "./types";

const REFRESH_DEBOUNCE_MS = 250;
// Neon has no Realtime: open views refetch on this interval while the tab is
// visible (and immediately after our own writes). Gentle on Neon Free compute.
const NEON_POLL_MS = 30_000;
// Worlds are live gatherings: an open World refreshes its posts and standings more often, and its chat every few seconds.
const WORLD_POLL_MS = 10_000;
const CHAT_POLL_MS = 4_000;

// -------------------------------------------------------- local invalidation
// After our own writes, refresh open views immediately instead of waiting for
// the realtime round trip.

/** Open views' refresh functions, by view name (so a change can refresh just the views it affects). */
const invalidators = new Map<() => void, string>();
const invalidate = () => {
  dropPrefetches();
  invalidators.forEach((_, fn) => fn());
};
const invalidateWhere = (match: (name: string) => boolean) => invalidators.forEach((name, fn) => match(name) && fn());

// Nobody has touched the app for a while (phone on the table, tab left open):
// open views refresh 4× less often; the first touch afterwards refreshes them at once.
const IDLE_AFTER_MS = 2 * 60_000;
let lastInput = Date.now();
if (typeof window !== "undefined") {
  const touched = () => {
    const wasIdle = Date.now() - lastInput > IDLE_AFTER_MS;
    lastInput = Date.now();
    if (wasIdle) invalidate();
  };
  for (const type of ["pointerdown", "keydown", "touchstart", "wheel"]) window.addEventListener(type, touched, { passive: true, capture: true });
}
const userIdle = () => Date.now() - lastInput > IDLE_AFTER_MS;
// Reads sent with a sign-in token the database hadn't honoured yet came back as signed out
// (no own likes); read the open views again (see neonClient.ts).
if (typeof window !== "undefined") window.addEventListener("amigo:fresh-token-reread", () => invalidate());

/**
 * Debounced live query: fetch now, refetch on realtime events / local writes.
 * On Neon (no Realtime) it polls instead, every `pollMs` while the tab is visible.
 */
function liveQuery<T>(
  name: string,
  fetcher: () => Promise<T>,
  sub: Subscription<T>,
  listen: (ch: RealtimeChannel, refresh: () => void) => RealtimeChannel,
  pollMs = NEON_POLL_MS,
): () => void {
  let active = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let again = false;

  let first = true;
  const run = async () => {
    if (running) { again = true; return; }
    running = true;
    try {
      // The first load may already be on its way (started at sign-in, see prefetchStart).
      const early = first ? takePrefetch<T>(name) : undefined;
      first = false;
      const value = (early && (await early)) ?? (await fetcher());
      remember(name, value);
      if (active) sub.onData(value);
    } catch (e) {
      if (active) sub.onError(e as Error);
    } finally {
      running = false;
      if (again && active) { again = false; void run(); }
    }
  };
  const refresh = () => {
    clearTimeout(timer);
    timer = setTimeout(run, REFRESH_DEBOUNCE_MS);
  };

  // Show what this screen had last time at once (this tab's memory only), then refresh.
  const last = cached<T>(name);
  if (last !== undefined) sub.onData(last, { cached: true });
  void run();
  invalidators.set(refresh, name);
  if (isNeon) {
    let ticks = 0;
    const poll = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      if (userIdle() && ++ticks % 4 !== 0) return;
      refresh();
    }, pollMs);
    const onVisible = () => document.visibilityState === "visible" && refresh();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      active = false;
      clearTimeout(timer);
      clearInterval(poll);
      document.removeEventListener("visibilitychange", onVisible);
      invalidators.delete(refresh);
    };
  }
  const channel = listen(supabase.channel(`${name}:${crypto.randomUUID()}`), refresh).subscribe();
  return () => {
    active = false;
    clearTimeout(timer);
    invalidators.delete(refresh);
    void supabase.removeChannel(channel);
  };
}

// ------------------------------------------------------------- app pulse
//
// Neon has no Realtime, so instead of every open view polling on its own, one
// tiny read (app_pulse: a few counts and timestamps, see its migration) asks
// what changed for the signed-in person every few seconds while the app is on
// screen, and only the views it affects refresh. Messages have their own
// equivalent (dm_pulse, see supabase/messages.ts). Nothing runs while the app
// is hidden (iOS suspends it anyway): coming back, or the connection
// returning, checks at once and refreshes every open view.
//
// Other screens that load once (a profile) listen for it (src/lib/sync.ts).

const PULSE_ACTIVE_MS = 4_000;
const PULSE_IDLE_MS = 20_000;
let pulseTimer: ReturnType<typeof setTimeout> | undefined;
let pulseRunning = false;
let lastPulse: Record<string, string> | null = null;

async function appPulse() {
  clearTimeout(pulseTimer);
  if (pulseRunning) return;
  if (!currentUser || document.visibilityState !== "visible") return schedulePulse();
  pulseRunning = true;
  try {
    const { data, error } = await supabase.rpc("app_pulse" as never);
    if (error || !data) return;
    const now = Object.fromEntries(Object.entries(data as Record<string, unknown>).map(([k, v]) => [k, JSON.stringify(v)]));
    const before = lastPulse;
    lastPulse = now;
    if (!before) return; // the first answer is the baseline: views have just loaded
    const changed = Object.keys(now).filter((k) => now[k] !== before[k]);
    if (!changed.length) return;
    // New activity on your posts (a like, a reply) also changes the counts shown with them.
    if (changed.includes("n")) invalidateWhere((n) => /^(notifications|feed:|post:|replies:|profile:)/.test(n));
    if (changed.includes("p")) invalidateWhere((n) => n.startsWith("feed:"));
    if (changed.includes("mo")) invalidateWhere((n) => n === "moments");
    announceSync(changed);
  } catch {
    // Offline or a hiccup: the next check tries again.
  } finally {
    pulseRunning = false;
    schedulePulse();
  }
}

function schedulePulse() {
  clearTimeout(pulseTimer);
  if (!currentUser) return;
  pulseTimer = setTimeout(() => void appPulse(), userIdle() ? PULSE_IDLE_MS : PULSE_ACTIVE_MS);
}

if (isNeon && typeof window !== "undefined") {
  // Back on screen, or back online: everything open refreshes, then the regular checks resume.
  const catchUp = () => {
    if (document.visibilityState !== "visible" || !currentUser) return;
    invalidate();
    announceSync(["all"]);
    void appPulse();
  };
  document.addEventListener("visibilitychange", catchUp);
  window.addEventListener("online", catchUp);
  window.addEventListener("pageshow", (e) => (e as PageTransitionEvent).persisted && catchUp());
}

// --------------------------------------------------------------------- auth

const AUTH_CODES: Record<string, AuthErrorCode> = {
  invalid_credentials: "invalid-credentials",
  user_already_exists: "email-in-use",
  email_exists: "email-in-use",
  weak_password: "weak-password",
  email_address_invalid: "invalid-email",
  validation_failed: "invalid-email",
  email_not_confirmed: "email-not-confirmed",
  over_request_rate_limit: "rate-limited",
  over_email_send_rate_limit: "rate-limited",
  // Neon Auth (Better Auth) codes.
  USER_ALREADY_EXISTS: "email-in-use",
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: "email-in-use",
  PASSWORD_TOO_SHORT: "weak-password",
  PASSWORD_TOO_LONG: "weak-password",
  INVALID_EMAIL: "invalid-email",
  INVALID_EMAIL_OR_PASSWORD: "invalid-credentials",
  INVALID_OTP: "invalid-code",
  OTP_EXPIRED: "invalid-code",
  TOO_MANY_ATTEMPTS: "rate-limited",
  EMAIL_NOT_VERIFIED: "email-not-confirmed",
};

function authError(e: SupabaseAuthError | Error): AuthError {
  const code = (e as SupabaseAuthError).code ?? "";
  if (/fetch|network/i.test(e.message) && !code) return new AuthError("network", e.message);
  return new AuthError(AUTH_CODES[code] ?? "unknown", e.message);
}

const LEGACY_SIGNIN = import.meta.env.VITE_LEGACY_SIGNIN === "true";

/**
 * People migrated from Firebase have no Supabase password yet. If a normal
 * sign-in fails, ask the legacy-sign-in function to verify the password
 * against Firebase; on success it sets it as their Supabase password.
 */
async function tryLegacySignIn(email: string, password: string): Promise<boolean> {
  // The Firebase bridge is a Supabase Edge Function; Neon has none.
  if (!LEGACY_SIGNIN || isNeon) return false;
  const { data, error } = await supabase.functions.invoke<{ status: string }>("legacy-sign-in", { body: { email, password } });
  if (data?.status === "migrated") return true;
  // 429 from the bridge: surface it rather than claiming the password is wrong.
  const status = (error as { context?: { status?: number } } | null)?.context?.status;
  if (status === 429) throw new AuthError("rate-limited");
  return false;
}

/** Photos of a post being published that already reached the bucket (reused if the post is retried). */
const uploadedPostMedia = new WeakMap<Blob, string>();

/** Startup publishes the session twice (initial auth event + explicit sync): share a profile load that's still in flight. */
let profileLoad: { id: string; promise: ReturnType<typeof q.fetchProfile> } | null = null;

async function loadViewer(user: { id: string; email?: string | null; email_confirmed_at?: string | null }): Promise<Viewer> {
  // The profile row is created by a trigger in the same transaction as the user.
  if (profileLoad?.id !== user.id) {
    const load = { id: user.id, promise: q.fetchProfile(supabase, user.id) };
    profileLoad = load;
    void load.promise.finally(() => profileLoad === load && (profileLoad = null)).catch(() => undefined);
  }
  let data = await profileLoad!.promise.catch(() => null);
  // A failed profile read (flaky network) must not leave the app with a
  // placeholder name and handle: retry once now, and again in the background.
  if (!data) data = await q.fetchProfile(supabase, user.id).catch(() => null);
  if (!data) scheduleViewerRetry(user.id);
  return {
    id: user.id,
    name: data?.display_name ?? "Amigo",
    handle: data?.username ?? "amigo",
    email: user.email ?? null,
    avatarUrl: data?.avatar_url ?? null,
    emailVerified: !!user.email_confirmed_at,
  };
}

const viewerListeners = new Set<(v: Viewer | null) => void>();
const recoveryListeners = new Set<() => void>();
let currentUser: { id: string; email?: string | null; email_confirmed_at?: string | null } | null = null;

let viewerRetry: ReturnType<typeof setTimeout> | null = null;
function scheduleViewerRetry(userId: string) {
  if (viewerRetry) return;
  viewerRetry = setTimeout(() => {
    viewerRetry = null;
    if (currentUser?.id === userId) void emitViewer();
  }, 8000);
}

let emitGeneration = 0;
async function emitViewer() {
  // Only the latest call may publish: a slow profile load must not overwrite a newer sign-in/out.
  const generation = ++emitGeneration;
  const v = currentUser ? await loadViewer(currentUser) : null;
  if (generation === emitGeneration) viewerListeners.forEach((cb) => cb(v));
  // Someone (else) signed in, or out: start the change checks afresh, or stop them.
  lastPulse = null;
  if (isNeon) {
    if (currentUser) void appPulse();
    else clearTimeout(pulseTimer);
  }
}

/**
 * Re-read the session and publish it. Neon's SDK broadcasts auth changes to
 * other tabs only (it ignores its own tab's messages), so after sign-in,
 * sign-up, verification or sign-out in this tab we publish explicitly.
 */
async function syncSession() {
  const { data } = await supabase.auth.getSession();
  currentUser = data.session?.user ?? null;
  setCacheOwner(currentUser?.id ?? null);
  if (currentUser) prefetchStart(currentUser.id);
  await emitViewer();
}

/**
 * Right after the session is known, start the first page of the feed alongside
 * loading the profile, instead of one after another (each round trip is
 * 0.2–0.5 s on mobile networks). Only once the session's token is there: a
 * request sent without it would be answered as a signed-out visitor. The legal
 * check is never fetched early — the gate always asks the server itself, so it
 * can't be skipped by an early answer.
 */
function prefetchStart(userId: string) {
  prefetch("feed:latest", async () => {
    const { data } = await supabase.auth.getSession();
    if (data.session?.user?.id !== userId || !data.session.access_token) throw new Error("no token yet");
    return q.fetchFeed(supabase, "latest", FIRST_FEED_PAGE, userId);
  });
}
/** Matches the feed's first page (src/features/feed/useFeed.ts). */
const FIRST_FEED_PAGE = 15;

supabase.auth.onAuthStateChange((event, session) => {
  const next = session?.user ?? null;
  setCacheOwner(next?.id ?? null);
  const changed = next?.id !== currentUser?.id || event === "USER_UPDATED" || event === "INITIAL_SESSION";
  currentUser = next;
  if (event === "PASSWORD_RECOVERY") recoveryListeners.forEach((cb) => cb());
  // Supabase recommends not awaiting other client calls inside this callback.
  if (changed) setTimeout(() => {
    if (next) prefetchStart(next.id);
    void emitViewer();
  }, 0);
});

// ------------------------------------------------------------------- source

// Messages (E2EE to-device delivery) and Moments (photo storage) need Realtime
// and Storage; on Neon they're migrated in a later step, so they stay off.
// Neon keeps files in Cloudflare R2 through the media service, once it's configured
// (VITE_MEDIA_STORAGE=r2 at build time, R2_* variables on the server). Until then: text only.
const media = isNeon && import.meta.env.VITE_MEDIA_STORAGE === "r2"
  ? createMediaStore(async () => (await supabase.auth.getSession()).data.session?.access_token ?? null)
  : null;
if (media) {
  q.useMediaService(media.url);
  setMediaSigner(media.sign);
}
const moments = createSupabaseMoments(supabase, liveQuery, invalidate, { photos: !isNeon || !!media, media });
const platform = createPlatform(supabase);
const push = createPushApi(supabase);

/** Asks the server to notify the recipient's phones about a new message (it decides who and whether). */
function pushNewMessage(conversationId: string) {
  void supabase.auth.getSession().then(({ data }) => {
    const token = data.session?.access_token;
    if (!token) return;
    return fetch("/api/push-notify", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ conversationId }),
      keepalive: true,
    }).catch(() => undefined);
  });
}

/**
 * After a like, reply, mention, follow or support: asks the server to push the
 * new notification to the other person's phones (it decides who and whether,
 * groups bursts, and pushes each notification once). Debounced, so a run of
 * likes is one request.
 */
let activityTimer: ReturnType<typeof setTimeout> | undefined;
function pushActivity() {
  if (!isNeon) return;
  clearTimeout(activityTimer);
  activityTimer = setTimeout(() => {
    void supabase.auth.getSession().then(({ data }) => {
      const token = data.session?.access_token;
      if (!token) return;
      return fetch("/api/push-notify", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ activity: true }),
        keepalive: true,
      }).catch(() => undefined);
    });
  }, 1500);
}

async function forgetPushDevice() {
  if (!isNeon || typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  const sub = await (await navigator.serviceWorker.getRegistration())?.pushManager?.getSubscription();
  if (!sub) return;
  await push.unsubscribe(sub.endpoint).catch(() => undefined);
  await sub.unsubscribe();
}
// Post tools + moderation need migration 20261017130000 (applied on Neon only).
if (isNeon) {
  q.enablePostTools();
  q.enableNotificationRequests();
}
const moderation = isNeon ? createModeration(supabase, invalidate) : null;

export const supabaseSource: DataSource = {
  kind: isNeon ? "neon" : "supabase",
  // post_media.position is 0–3 and create_post rejects more than 4. Neon: no photo storage yet.
  maxMediaPerPost: isNeon && !media ? 0 : 4,
  photoUploads: !isNeon || !!media,

  legal: {
    ...platform.legal,
    async accept(docs) {
      dropPrefetches();
      return platform.legal.accept(docs);
    },
  },
  monetization: platform.monetization,
  creatorProgramme: platform.creatorProgramme,
  ...(media
    ? {
        async mediaBytes(src: string) {
          const key = src.startsWith("/api/media/") ? src.slice("/api/media/".length).split("?")[0] : src;
          return new Blob([(await media.bytes(key)) as BlobPart]);
        },
      }
    : {}),
  postTools: moderation?.postTools,
  accountStatus: moderation?.accountStatus,
  acknowledgeWarning: moderation?.acknowledgeWarning,
  reportError: moderation?.reportError,
  reportPerf: moderation?.reportPerf,
  blocking: moderation?.blocking,

  async deleteAccount(password) {
    if (!currentUser?.email) throw new AuthError("unknown", "Not signed in");
    const userId = currentUser.id;
    // Fresh sign-in = recent authentication (the database refuses deletion without one).
    const { error } = await supabase.auth.signInWithPassword({ email: currentUser.email, password });
    if (error) throw authError(error);
    const { error: delError } = await supabase.rpc("delete_my_account" as never, { p_confirm: "DELETE" } as never);
    if (delError) throw new AuthError(delError.code === "AC001" ? "invalid-credentials" : "unknown", delError.message);
    // Forget this browser's keys, drafts, photos and session for the deleted account.
    setCacheOwner(null);
    await clearMediaCache();
    try {
      for (const k of Object.keys(localStorage)) if (k.includes(userId)) localStorage.removeItem(k);
      if (typeof indexedDB !== "undefined" && indexedDB.databases) {
        for (const d of await indexedDB.databases()) if (d.name?.startsWith(`amigo-crypto-${userId}`)) indexedDB.deleteDatabase(d.name);
      }
    } catch {
      /* best effort */
    }
    await supabase.auth.signOut().catch(() => undefined);
    currentUser = null;
    await emitViewer();
  },

  interests: {
    async get() {
      const { data, error } = await supabase.rpc("my_interests" as never);
      if (error) throw error;
      return ((data as string[] | null) ?? []).filter((i): i is Interest => (INTERESTS as readonly string[]).includes(i));
    },
    async set(list) {
      const { data, error } = await supabase.rpc("set_my_interests" as never, { p_interests: list } as never);
      if (error) throw error;
      return (data as Interest[] | null) ?? [];
    },
  },
  socialSignIn: isNeon
    ? {
        providers: ["google"],
        async start(provider) {
          const { neonSocial } = await import("./supabase/neonClient");
          await neonSocial.start(provider);
        },
      }
    : undefined,

  emailVerification: isNeon
    ? {
        async sendCode() {
          if (!currentUser?.email) throw new AuthError("unknown", "Not signed in");
          const { neonEmailCodes } = await import("./supabase/neonClient");
          await neonEmailCodes.send(currentUser.email).catch((e: Error) => {
            throw authError(e);
          });
        },
        async verify(code) {
          if (!currentUser?.email) throw new AuthError("unknown", "Not signed in");
          const { neonEmailCodes } = await import("./supabase/neonClient");
          await neonEmailCodes.verify(currentUser.email, code).catch((e: Error) => {
            throw authError(e);
          });
          await syncSession();
        },
      }
    : undefined,

  passwordResetByCode: isNeon
    ? {
        async send(email) {
          const { neonPasswordReset } = await import("./supabase/neonClient");
          await neonPasswordReset.send(email).catch((e: Error) => {
            throw authError(e);
          });
        },
        async reset(email, code, password) {
          const { neonPasswordReset } = await import("./supabase/neonClient");
          await neonPasswordReset.reset(email, code, password).catch((e: Error) => {
            throw authError(e);
          });
        },
      }
    : undefined,

  onViewerChanged(cb) {
    viewerListeners.add(cb);
    // Late subscribers get the current state once the initial session is known.
    void supabase.auth.getSession().then(({ data }) => {
      currentUser = data.session?.user ?? null;
      return currentUser ? loadViewer(currentUser).then(cb) : cb(null);
    });
    return () => viewerListeners.delete(cb);
  },

  onPasswordRecovery(cb) {
    recoveryListeners.add(cb);
    return () => recoveryListeners.delete(cb);
  },

  async signIn(email, password) {
    const first = await supabase.auth.signInWithPassword({ email, password });
    if (!first.error) {
      if (isNeon) await syncSession();
      return;
    }
    if ((first.error as SupabaseAuthError).code === "invalid_credentials" && (await tryLegacySignIn(email, password))) {
      const second = await supabase.auth.signInWithPassword({ email, password });
      if (!second.error) return;
      throw authError(second.error);
    }
    throw authError(first.error);
  },

  async signUp(email, password, name, opts) {
    if (isNeon) {
      const { neonSignUp } = await import("./supabase/neonClient");
      await neonSignUp(email, password, name.trim()).catch((e: Error) => {
        throw authError(e);
      });
      // Record the Terms/Privacy versions accepted on the form (server time). If this
      // fails, the acceptance screen asks again before the app opens — never skipped.
      if (opts?.acceptLegal?.length) await platform.legal.accept(opts.acceptLegal).catch((e) => console.warn("legal acceptance not recorded yet", e));
      await syncSession();
      // Signed in straight away; the email is verified by code from Settings.
      return { needsEmailConfirmation: false };
    }
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { display_name: name.trim() }, emailRedirectTo: `${location.origin}/` },
    });
    if (error) throw authError(error);
    // With confirmations on, Supabase returns a user with no identities for an
    // already-registered email (to avoid leaking which emails exist).
    return { needsEmailConfirmation: !data.session };
  },

  async sendPasswordReset(email) {
    const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: `${location.origin}/` });
    if (error) throw authError(error);
  },

  async updatePassword(newPassword) {
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    if (error) throw authError(error);
  },

  async signOut() {
    // This device stops getting the account's notifications (while the session can still say so).
    await forgetPushDevice().catch(() => undefined);
    setCacheOwner(null);
    await clearMediaCache();
    await supabase.auth.signOut();
    if (isNeon) {
      currentUser = null;
      await emitViewer();
    }
  },

  async updateDisplayName(name) {
    if (!currentUser) throw new Error("Not signed in");
    await q.updateDisplayName(supabase, currentUser.id, name);
    await emitViewer();
  },

  subscribeLatestPosts(viewerId, limit, sub, scope: FeedScope = "latest") {
    return liveQuery(
      `feed:${scope}`,
      () => q.fetchFeed(supabase, scope, limit, viewerId),
      sub,
      (ch, refresh) => ch.on("postgres_changes", { event: "*", schema: "public", table: "posts" }, refresh),
    );
  },

  subscribePost(postId, viewerId, sub) {
    return liveQuery(
      `post:${postId}`,
      () => q.fetchPost(supabase, postId, viewerId),
      sub,
      (ch, refresh) => ch.on("postgres_changes", { event: "*", schema: "public", table: "posts", filter: `id=eq.${postId}` }, refresh),
    );
  },

  async createPost(viewer, input) {
    if (input.media.length > supabaseSource.maxMediaPerPost) throw new Error(`At most ${supabaseSource.maxMediaPerPost} images per post`);
    // Upload in parallel, keep the composer's order. Paths live in the author's own folder (Storage RLS).
    const uploads = await Promise.allSettled(
      input.media.map(async (m) => {
        if (media) {
          // Neon: Postgres picks the key; unused uploads are swept after a day.
          // A retry reuses a photo that already reached the bucket (not attached to anything yet).
          const [key, preview] = await Promise.all([
            uploadedPostMedia.get(m.blob) ?? media.upload("post", m.blob),
            makePreview(m.blob).catch(() => null),
          ]);
          uploadedPostMedia.set(m.blob, key);
          return { kind: "image" as const, storage_path: key, mime_type: m.blob.type, width: m.width, height: m.height, byte_size: m.blob.size, preview };
        }
        const ext = m.blob.type === "image/png" ? "png" : m.blob.type === "image/webp" ? "webp" : m.blob.type === "image/gif" ? "gif" : "jpg";
        const path = `${viewer.id}/${crypto.randomUUID()}.${ext}`;
        const { error } = await supabase.storage.from("post-media").upload(path, m.blob, { contentType: m.blob.type, cacheControl: "31536000" });
        if (error) throw q.dataError(error);
        return { kind: "image" as const, storage_path: path, mime_type: m.blob.type, width: m.width, height: m.height, byte_size: m.blob.size };
      }),
    );
    const uploaded = uploads.flatMap((u) => (u.status === "fulfilled" ? [u.value] : []));
    const cleanup = () => !media && uploaded.length && void supabase.storage.from("post-media").remove(uploaded.map((u) => u.storage_path));
    const failed = uploads.find((u) => u.status === "rejected");
    if (failed) {
      cleanup();
      throw (failed as PromiseRejectedResult).reason;
    }
    let created: { id: string };
    try {
      // One transaction: the post and all its post_media rows, in order.
      created = input.world
        ? await q.createWorldPost(supabase, input.world.id, input.world.entry, input.text, uploaded, input.clientRef)
        : await q.createPost(supabase, input.text, { media: uploaded, clientRef: input.clientRef });
    } catch (e) {
      cleanup(); // don't leave orphaned uploads behind
      throw e;
    }
    invalidate();
    if (/@\w/.test(input.text)) pushActivity(); // mentions
    return { id: created.id };
  },

  async setLiked(postId, _viewerId, liked) {
    await q.setLike(supabase, postId, liked);
    invalidate();
    if (liked) pushActivity();
  },

  subscribeReplies(postId, sub) {
    return liveQuery(
      `replies:${postId}`,
      () => q.fetchReplies(supabase, postId, currentUser?.id ?? null),
      sub,
      (ch, refresh) => ch.on("postgres_changes", { event: "*", schema: "public", table: "posts", filter: `parent_id=eq.${postId}` }, refresh),
    );
  },

  async addReply(postId, _viewer, text) {
    await q.createPost(supabase, text, { parentId: postId });
    invalidate();
    pushActivity();
  },

  getFollowingIds: (viewerId) => q.fetchFollowingIds(supabase, viewerId),
  getPeopleSuggestions: (viewerId, max) => q.fetchSuggestions(supabase, viewerId, max),

  async follow(viewerId, targetId) {
    await q.follow(supabase, viewerId, targetId);
    invalidate();
    pushActivity();
  },

  async unfollow(viewerId, targetId) {
    await q.unfollow(supabase, viewerId, targetId);
    invalidate();
  },

  discovery: {
    explore: (viewerId) => q.fetchExplore(supabase, viewerId),
    searchPeople: (query, viewerId, limit) => q.searchPeople(supabase, query, viewerId, limit),
    searchPosts: (query, viewerId, opts) => q.searchPosts(supabase, query, viewerId, opts),
  },

  worlds: {
    listWorlds: (viewerId) => q.fetchWorlds(supabase, viewerId),

    subscribeWorld(slug, viewerId, sub) {
      return liveQuery(
        `world:${slug}`,
        () => q.fetchWorld(supabase, slug, viewerId),
        sub,
        // participant_count changes arrive as updates on the worlds row.
        (ch, refresh) => ch.on("postgres_changes", { event: "*", schema: "public", table: "worlds", filter: `slug=eq.${slug}` }, refresh),
        WORLD_POLL_MS,
      );
    },

    async join(worldId, viewerId) {
      await q.joinWorld(supabase, worldId, viewerId);
      invalidate();
    },

    async leave(worldId, viewerId) {
      await q.leaveWorld(supabase, worldId, viewerId);
      invalidate();
    },

    subscribeWorldPosts(worldId, viewerId, opts, sub) {
      return liveQuery(
        `world-posts:${worldId}:${opts.entriesOnly}`,
        () => q.fetchWorldPosts(supabase, worldId, viewerId, opts),
        sub,
        (ch, refresh) => ch.on("postgres_changes", { event: "*", schema: "public", table: "posts", filter: `world_id=eq.${worldId}` }, refresh),
        WORLD_POLL_MS,
      );
    },

    subscribeLeaderboard(worldId, viewerId, sub) {
      return liveQuery(
        `world-board:${worldId}`,
        () => q.fetchLeaderboard(supabase, worldId, viewerId),
        sub,
        // Scores move with likes/replies, which surface as counter updates on the World's posts.
        (ch, refresh) => ch.on("postgres_changes", { event: "*", schema: "public", table: "posts", filter: `world_id=eq.${worldId}` }, refresh),
        WORLD_POLL_MS,
      );
    },

    subscribeChat(worldId, limit, sub) {
      return liveQuery(
        `world-chat:${worldId}`,
        () => q.fetchChat(supabase, worldId, limit),
        sub,
        (ch, refresh) =>
          ch.on("postgres_changes", { event: "INSERT", schema: "public", table: "world_chat_messages", filter: `world_id=eq.${worldId}` }, refresh),
        CHAT_POLL_MS,
      );
    },

    async sendChat(worldId, _viewer, text) {
      await q.sendChat(supabase, worldId, text);
      invalidate();
    },

    listParticipants: (worldId, viewerId, limit) => q.fetchParticipants(supabase, worldId, viewerId, limit),
    // Neon schema (migration 20261019120000).
    ...(isNeon
      ? {
          serverTime: () => worldsExtra.serverTime(supabase),
          notices: (viewerId: string) => worldsExtra.fetchWorldNotices(supabase, viewerId),
          async markNoticesRead() {
            const { error } = await supabase.rpc("mark_world_notices_read" as never);
            if (error) throw new Error(error.message);
            invalidate();
          },
          tick: () => worldsExtra.worldsTick(supabase),
          admin: worldsExtra.createWorldsAdmin(supabase),
        }
      : {}),
  },

  support: {
    config: () => q.fetchSupportConfig(supabase),
    wallet: () => q.fetchWallet(supabase),

    subscribeRequests(viewerId, opts, sub) {
      return liveQuery(
        `support:${opts.section}:${opts.category ?? ""}`,
        () => q.fetchSupportRequests(supabase, viewerId, opts),
        sub,
        (ch, refresh) => ch.on("postgres_changes", { event: "*", schema: "public", table: "support_requests" }, refresh),
      );
    },

    subscribeRequest(id, viewerId, sub) {
      return liveQuery(
        `support:${id}`,
        () => q.fetchSupportRequest(supabase, id, viewerId),
        sub,
        (ch, refresh) => ch.on("postgres_changes", { event: "*", schema: "public", table: "support_requests", filter: `id=eq.${id}` }, refresh),
      );
    },

    async createRequest(_viewerId, input) {
      const res = await q.createSupportRequest(supabase, input);
      invalidate();
      return res;
    },
    async openSupport(requestId) {
      await q.openSupport(supabase, requestId);
      invalidate();
    },
    async confirmSupport(requestId) {
      const res = await q.confirmSupport(supabase, requestId);
      invalidate();
      pushActivity();
      return res;
    },
    async leaveFeedback(requestId, _viewerId, { reaction, text }) {
      const res = await q.leaveFeedback(supabase, requestId, reaction, text);
      invalidate();
      return res;
    },
    listFeedback: (requestId) => q.fetchFeedback(supabase, requestId),
    report: (requestId, _viewerId, reason) => q.reportSupport(supabase, requestId, reason),
    profileStats: (profileId) => q.fetchSupportProfileStats(supabase, profileId),
  },

  // The admin UI is only a convenience: every call below is re-checked by is_admin() in the database.
  admin: {
    isAdmin: () => q.fetchIsAdmin(supabase),
    legal: platform.legalAdmin,
    moderation: moderation?.admin,
    monetization: platform.monetizationAdmin,
    creatorProgramme: platform.creatorProgrammeAdmin,
    moments: moments?.admin,
    // Evidence is only what the reporter chose to attach from their own decrypted copy.
    messageReports: {
      list: () => q.adminMessageReports(supabase),
      async setStatus(_adminId, reportId, status) {
        await q.adminSetMessageReportStatus(supabase, reportId, status);
        invalidate();
      },
    },
    support: {
      listRequests: (adminId, status) => q.adminListRequests(supabase, adminId, status),
      async moderate(_adminId, requestId, action, note) {
        await q.adminModerate(supabase, requestId, action, note);
        invalidate();
      },
      listReports: (_adminId, status) => q.adminReports(supabase, status),
      resolveReport: (_adminId, reportId, outcome) => q.adminResolveReport(supabase, reportId, outcome),
      suspicious: () => q.adminSuspicious(supabase),
      supporters: (_adminId, requestId) => q.adminSupporters(supabase, requestId),
      findUser: (adminId, handle) => q.adminFindUser(supabase, adminId, handle),
      adjustCredits: (_adminId, userId, delta, note) => q.adminAdjustCredits(supabase, userId, delta, note),
      audit: (_adminId, limit) => q.adminAudit(supabase, limit),
    },
    users: {
      find: (adminId, handle) => q.adminFindUserProfile(supabase, adminId, handle),
      async verify(_adminId, userId, type, note) {
        await q.adminVerify(supabase, userId, type, note);
        invalidate();
      },
      async unverify(_adminId, userId, note) {
        await q.adminUnverify(supabase, userId, note);
        invalidate();
      },
      listVerified: (adminId) => q.adminVerifiedUsers(supabase, adminId),
    },
  },

  moments: moments?.api,

  // End-to-end encrypted; the crypto library loads on first use.
  messages: createSupabaseMessages(supabase, liveQuery, invalidate, { realtime: !isNeon, media, onSent: isNeon ? pushNewMessage : undefined }),
  push: isNeon ? push : undefined,

  notifications: {
    subscribeNotifications(viewerId, limit, sub) {
      return liveQuery(
        "notifications",
        () => q.fetchNotifications(supabase, limit),
        sub,
        (ch, refresh) =>
          ch.on("postgres_changes", { event: "*", schema: "public", table: "notifications", filter: `recipient_id=eq.${viewerId}` }, refresh),
      );
    },

    subscribeUnreadCount(viewerId, sub) {
      return liveQuery(
        "notifications:unread",
        () => q.fetchUnreadCount(supabase),
        sub,
        (ch, refresh) =>
          ch.on("postgres_changes", { event: "*", schema: "public", table: "notifications", filter: `recipient_id=eq.${viewerId}` }, refresh),
      );
    },

    async markRead(_viewerId, ids) {
      await q.markNotificationsRead(supabase, ids);
      invalidate();
    },

    async markAllRead() {
      await q.markNotificationsRead(supabase);
      invalidate();
    },
  },

  profiles: {
    getProfile: (handle, viewerId) => q.fetchProfileByHandle(supabase, handle, viewerId),

    subscribeProfilePosts(profileId, viewerId, tab, limit, sub) {
      return liveQuery(
        `profile:${profileId}:${tab}`,
        () => q.fetchProfilePosts(supabase, profileId, viewerId, tab, limit),
        sub,
        (ch, refresh) => ch.on("postgres_changes", { event: "*", schema: "public", table: "posts", filter: `author_id=eq.${profileId}` }, refresh),
      );
    },

    listFollows: (profileId, kind, viewerId) => q.fetchFollowList(supabase, profileId, kind, viewerId),
    isHandleAvailable: (handle, viewerId) => q.isHandleAvailable(supabase, handle, viewerId),

    async updateProfile(viewerId, update) {
      const patch: Parameters<typeof q.updateProfileRow>[2] = {};
      if (update.name !== undefined) patch.display_name = update.name.trim();
      if (update.bio !== undefined) patch.bio = update.bio.trim();
      if (update.handle !== undefined) patch.username = update.handle.toLowerCase();
      let uploaded: string | null = null;
      if (update.avatar === null) patch.avatar_url = null;
      else if (update.avatar) {
        const blob = await (await fetch(update.avatar.dataUrl)).blob();
        if (media) {
          // Neon: the database checks it's your own avatar upload and releases the old one.
          const key = await media.upload("avatar", blob);
          patch.avatar_url = media.url(key);
        } else {
          uploaded = `${viewerId}/${crypto.randomUUID()}.jpg`;
          const { error } = await supabase.storage.from("avatars").upload(uploaded, blob, { contentType: blob.type, cacheControl: "31536000" });
          if (error) throw new ProfileError("unknown", error.message);
          patch.avatar_url = supabase.storage.from("avatars").getPublicUrl(uploaded).data.publicUrl;
        }
      }
      try {
        await q.updateProfileRow(supabase, viewerId, patch);
      } catch (e) {
        if (uploaded) void supabase.storage.from("avatars").remove([uploaded]);
        throw e;
      }
      await emitViewer();
      invalidate();
    },
  },
};
