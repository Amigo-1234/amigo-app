/**
 * Support Hub + admin for the in-memory demo source. Same rules as the
 * Supabase migration (20261006170000_support_hub.sql):
 *   - creating a request spends credits; new people get starter credits
 *   - supporting = open the link, then confirm (not before minVisitSeconds); once per request; never your own
 *   - credits/reputation come from a ledger, so every change is explainable
 *   - admin actions are authorised here (not just hidden in the UI) and audit-logged
 *
 * Demo viewer "me" is an admin so the admin area can be reviewed; open the app
 * with ?demo=member to be a regular member.
 */
import type {
  AdminApi,
  AdminAuditEntry,
  Author,
  NewSupportRequest,
  PersonSummary,
  Subscription,
  SupportAdminAction,
  SupportApi,
  SupportCategory,
  SupportConfig,
  SupportFeedback,
  SupportReaction,
  SupportReport,
  SupportRequest,
  SupportStatus,
  SuspiciousSupport,
  SupportWallet,
  Verification,
  VerificationType,
} from "./types";
import { SUPPORT_LIMITS, SupportError } from "./types";
import { BURST_COUNT, BURST_WINDOW_MIN, DEFAULT_SUPPORT_CONFIG, QUICK_CONFIRM_SECONDS, checkSupportUrl, dailyJitter, forYouScore } from "./supportRules";

export interface SupportDemoContext {
  personIds: () => string[];
  verification: {
    get: (id: string) => { type: VerificationType; note: string; at: Date; by: string | null } | null;
    set: (id: string, v: { type: VerificationType; note: string; at: Date; by: string | null } | null) => void;
  };
  handleOf: (id: string) => string | null;
  author: (id: string) => Author;
  summary: (id: string, viewerId: string) => PersonSummary;
  emit: () => void;
  watch: <T>(sub: Subscription<T>, read: () => T) => () => void;
  later: <T>(fn: () => T, ms?: number) => Promise<T>;
  scenario: string | null;
}

interface RequestRecord {
  id: string;
  creatorId: string;
  title: string;
  description: string;
  url: string;
  category: SupportCategory;
  ask: NewSupportRequest["ask"];
  target: number;
  createdAt: Date;
  status: SupportStatus;
  featured: boolean;
  completedAt: Date | null;
}

interface VisitRecord {
  requestId: string;
  userId: string;
  openedAt: Date;
  confirmedAt: Date | null;
  reaction: SupportReaction | null;
  feedback: string;
  feedbackAt: Date | null;
}

interface LedgerRecord {
  userId: string;
  credits: number;
  reputation: number;
  reason: "starter" | "request" | "refund" | "support" | "feedback" | "admin";
  requestId: string | null;
  at: Date;
}

const MIN = 60_000;
const HOUR = 60 * MIN;

export function createDemoSupport(ctx: SupportDemoContext) {
  const config: SupportConfig = { ...DEFAULT_SUPPORT_CONFIG };
  const admins = new Set(ctx.scenario === "member" ? [] : ["me"]);
  const now = Date.now();
  const ago = (ms: number) => new Date(now - ms);

  const requests: RequestRecord[] = [];
  const visits: VisitRecord[] = [];
  const ledger: LedgerRecord[] = [];
  const reports: { id: string; requestId: string; reporterId: string; reason: string; at: Date; status: SupportReport["status"] }[] = [];
  const auditLog: { id: string; adminId: string; action: string; summary: string; at: Date }[] = [];
  let seq = 0;

  // -------------------------------------------------------------- helpers
  const credit = (userId: string, credits: number, reputation: number, reason: LedgerRecord["reason"], requestId: string | null, at = new Date()) =>
    ledger.push({ userId, credits, reputation, reason, requestId, at });
  const ensureStarter = (userId: string) => {
    if (!ledger.some((l) => l.userId === userId && l.reason === "starter")) credit(userId, config.starterCredits, 0, "starter", null, ago(30 * 24 * HOUR));
  };
  const balance = (userId: string) => {
    ensureStarter(userId);
    return ledger.filter((l) => l.userId === userId).reduce((a, l) => ({ credits: a.credits + l.credits, reputation: a.reputation + l.reputation }), { credits: 0, reputation: 0 });
  };
  const supporters = (requestId: string) => visits.filter((v) => v.requestId === requestId && v.confirmedAt);
  const wallet = (userId: string): SupportWallet => ({
    ...balance(userId),
    helpedCount: visits.filter((v) => v.userId === userId && v.confirmedAt).length,
    activeRequests: requests.filter((r) => r.creatorId === userId && (r.status === "active" || r.status === "pending")).length,
  });
  const requireAdmin = (id: string) => {
    if (!admins.has(id)) throw new SupportError("not-admin", "Admins only");
  };
  const audit = (adminId: string, action: string, summary: string) => auditLog.unshift({ id: `a${++seq}`, adminId, action, summary, at: new Date() });
  const reqOr = (id: string) => {
    const r = requests.find((x) => x.id === id);
    if (!r) throw new SupportError("invalid", "No such request");
    return r;
  };
  const visible = (r: RequestRecord, viewerId: string) => r.status === "active" || r.status === "completed" || r.creatorId === viewerId || admins.has(viewerId);

  function toRequest(r: RequestRecord, viewerId: string): SupportRequest {
    const v = visits.find((x) => x.requestId === r.id && x.userId === viewerId);
    return {
      id: r.id,
      creator: ctx.author(r.creatorId),
      title: r.title,
      description: r.description,
      url: r.url,
      category: r.category,
      ask: r.ask,
      target: r.target,
      supporterCount: supporters(r.id).length,
      createdAt: r.createdAt,
      status: r.status,
      featured: r.featured,
      isViewer: r.creatorId === viewerId,
      viewerState: v?.confirmedAt ? "supported" : v ? "opened" : "none",
      viewerFeedback: Boolean(v?.feedbackAt),
    };
  }

  // ----------------------------------------------------------------- seed
  const seedReq = (id: string, creatorId: string, title: string, description: string, url: string, category: SupportCategory, ask: RequestRecord["ask"], target: number, hoursAgo: number, status: SupportStatus = "active", featured = false) => {
    ensureStarter(creatorId);
    requests.push({ id, creatorId, title, description, url, category, ask, target, createdAt: ago(hoursAgo * HOUR), status, featured, completedAt: null });
    credit(creatorId, -config.requestCost, 0, "request", id, ago(hoursAgo * HOUR));
  };
  const seedSupport = (requestId: string, userId: string, hoursAgo: number, secondsToConfirm: number, feedback?: { reaction: SupportReaction | null; text: string }) => {
    ensureStarter(userId);
    const openedAt = ago(hoursAgo * HOUR);
    const confirmedAt = new Date(openedAt.getTime() + secondsToConfirm * 1000);
    visits.push({ requestId, userId, openedAt, confirmedAt, reaction: feedback?.reaction ?? null, feedback: feedback?.text ?? "", feedbackAt: feedback ? confirmedAt : null });
    credit(userId, config.supportCredits, config.supportReputation, "support", requestId, confirmedAt);
    if (feedback) credit(userId, config.feedbackCredits, config.feedbackReputation, "feedback", requestId, confirmedAt);
  };

  seedReq("s-mira-chorus", "mira", "Listen to my new song — is the chorus catchy?", "Two-minute demo of my next single. Tell me honestly if the chorus sticks or if it drags.", "https://soundcloud.com/mira-iyer/friday-demo", "music", "listen", 10, 5, "active", true);
  seedReq("s-leo-app", "leo", "Try the signup of my hiking app", "Group hike planner. I want to know if signing up makes sense in under a minute.", "https://trailmates.app/signup", "app", "try", 8, 20);
  seedReq("s-zoe-intro", "zoe", "Watch my video intro — would you keep watching?", "First 30 seconds of my Paris film diary. Is the intro interesting enough?", "https://youtube.com/watch?v=zoe-paris-diary", "video", "watch", 12, 30);
  seedReq("s-kofi-menu", "kofi", "Feedback on my food stall menu", "Opening a jollof stall next month. Is the menu clear? Are the prices readable?", "https://kofis-kitchen.example.com/menu", "business", "read", 6, 44);
  seedReq("s-ama-portfolio", "ama", "Rate my photo portfolio layout", "New portfolio site. Does the grid feel too busy on a phone?", "https://amamensah.photo", "design", "visit", 10, 70);
  seedReq("s-rosa-blog", "rosa", "Read my first race recap post", "My half-marathon recap. Too long? Boring middle? Tell me.", "https://rosaruns.blog/first-half", "other", "read", 5, 90, "completed");
  seedReq("s-jun-page", "jun", "Check out my small-joys page", "A page where I post one small good thing every day. Does the idea land?", "https://instagram.com/junsmalljoys", "social", "visit", 8, 9);
  seedReq("s-tomi-beat", "tomi", "Listen to my first beat", "Made it on my phone. Be kind but honest about the drums.", "https://soundcloud.com/tomi-a/first-beat", "music", "listen", 10, 1, "pending");
  seedReq("s-me-timelapse", "me", "Watch my plant timelapse", "Thirty days of my window plants in 40 seconds. Is the music too much?", "https://youtube.com/watch?v=sam-plants", "video", "watch", 6, 50);
  seedReq("s-kofi-promo", "kofi", "FREE FOLLOWERS click here now", "Get 10k followers instantly, limited offer, click the link.", "https://free-followers.example.net", "social", "visit", 50, 3);

  seedSupport("s-mira-chorus", "ama", 4, 140, { reaction: "loved", text: "The chorus is great, maybe come in 4 bars earlier." });
  seedSupport("s-mira-chorus", "zoe", 3, 95, { reaction: "useful", text: "Second half of the chorus is the hook. Lead with it." });
  seedSupport("s-mira-chorus", "leo", 2, 60);
  seedSupport("s-leo-app", "kofi", 18, 210, { reaction: "useful", text: "Signup asked for my birthday — why? Otherwise quick." });
  seedSupport("s-leo-app", "me", 16, 180, { reaction: "nice", text: "Smooth. The 'invite friends' step could be skippable." });
  seedSupport("s-zoe-intro", "mira", 25, 120);
  seedSupport("s-zoe-intro", "me", 22, 75);
  seedSupport("s-kofi-menu", "rosa", 40, 160, { reaction: "keep_going", text: "Prices are clear. Add a spice level!" });
  ["ama", "leo", "mira", "zoe", "jun"].forEach((u, i) => seedSupport("s-rosa-blog", u, 85 - i * 6, 150 + i * 20));
  seedSupport("s-me-timelapse", "ama", 45, 100, { reaction: "loved", text: "So calming. Music is fine, maybe a bit quieter." });
  seedSupport("s-me-timelapse", "kofi", 40, 70);
  // Suspicious patterns for the admin view (real timestamps): Jun confirms within seconds, many times in a few minutes.
  ["s-mira-chorus", "s-leo-app", "s-zoe-intro", "s-kofi-menu", "s-ama-portfolio", "s-me-timelapse"].forEach((r, i) => seedSupport(r, "jun", 1.5 - i * 0.02, 3));
  for (const r of requests) if (r.status === "active" && supporters(r.id).length >= r.target) Object.assign(r, { status: "completed", completedAt: new Date() });
  requests.find((r) => r.id === "s-rosa-blog")!.completedAt = ago(60 * HOUR);
  reports.push({ id: "rep1", requestId: "s-kofi-promo", reporterId: "ama", reason: "Spam: promises fake followers", at: ago(2 * HOUR), status: "open" });
  reports.push({ id: "rep2", requestId: "s-kofi-promo", reporterId: "zoe", reason: "Looks like a scam link", at: ago(1 * HOUR), status: "open" });

  // ------------------------------------------------------------ discovery
  function list(viewerId: string, section: string, category: SupportCategory | null, query: string): RequestRecord[] {
    const q = query.trim().toLowerCase();
    const mine = (r: RequestRecord) => r.creatorId === viewerId;
    let pool = requests.filter((r) => visible(r, viewerId));
    if (category) pool = pool.filter((r) => r.category === category);
    if (q) pool = pool.filter((r) => `${r.title} ${r.description} ${ctx.author(r.creatorId).name}`.toLowerCase().includes(q));
    const supportedBy = (r: RequestRecord) => visits.some((v) => v.requestId === r.id && v.userId === viewerId && v.confirmedAt);
    const age = (r: RequestRecord) => (Date.now() - r.createdAt.getTime()) / HOUR;
    switch (section) {
      case "mine":
        return pool.filter(mine).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      case "completed":
        return pool.filter((r) => r.status === "completed").sort((a, b) => (b.completedAt?.getTime() ?? 0) - (a.completedAt?.getTime() ?? 0));
      case "new":
        return pool.filter((r) => r.status === "active").sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      case "needs":
        return pool
          .filter((r) => r.status === "active" && !mine(r))
          .sort((a, b) => b.target - supporters(b.id).length - (a.target - supporters(a.id).length) || a.createdAt.getTime() - b.createdAt.getTime());
      default: {
        const myCategories = new Set(visits.filter((v) => v.userId === viewerId && v.confirmedAt).map((v) => requests.find((r) => r.id === v.requestId)?.category));
        return pool
          .filter((r) => r.status === "active" && !mine(r) && !supportedBy(r))
          .map((r) => ({
            r,
            score: forYouScore({
              ageHours: age(r),
              supporterCount: supporters(r.id).length,
              target: r.target,
              categoryMatch: myCategories.has(r.category),
              seen: visits.some((v) => v.requestId === r.id && v.userId === viewerId),
              creatorReputation: balance(r.creatorId).reputation,
              featured: r.featured,
              jitter: dailyJitter(r.id, viewerId),
            }),
          }))
          .sort((a, b) => b.score - a.score)
          .map((x) => x.r);
      }
    }
  }

  const fail = () => {
    if (ctx.scenario === "error") throw new Error("Demo network error");
  };

  // ------------------------------------------------------------------ API
  const api: SupportApi = {
    config: () => ctx.later(() => ({ ...config }), 100),
    wallet: (viewerId) => ctx.later(() => (fail(), wallet(viewerId)), 150),

    subscribeRequests(viewerId, { section, category, query, limit }, sub) {
      return ctx.watch(sub, () => {
        const all = ctx.scenario === "empty" ? [] : list(viewerId, section, category, query);
        return { requests: all.slice(0, limit).map((r) => toRequest(r, viewerId)), hasMore: all.length > limit };
      });
    },

    subscribeRequest(id, viewerId, sub) {
      return ctx.watch(sub, () => {
        const r = requests.find((x) => x.id === id);
        return r && visible(r, viewerId) ? toRequest(r, viewerId) : null;
      });
    },

    createRequest: (viewerId, input) =>
      ctx.later(() => {
        const title = input.title.trim();
        const description = input.description.trim();
        const url = checkSupportUrl(input.url);
        if (title.length < SUPPORT_LIMITS.titleMin || title.length > SUPPORT_LIMITS.titleMax) throw new SupportError("invalid", "Title length");
        if (description.length < SUPPORT_LIMITS.descriptionMin || description.length > SUPPORT_LIMITS.descriptionMax) throw new SupportError("invalid", "Description length");
        if (!url.ok) throw new SupportError("invalid", url.error);
        if (!Number.isInteger(input.target) || input.target < config.minTarget || input.target > config.maxTarget) throw new SupportError("invalid", "Target");
        if (balance(viewerId).credits < config.requestCost) throw new SupportError("insufficient-credits");
        const id = `s${Date.now()}`;
        const status: SupportStatus = config.moderation && !admins.has(viewerId) ? "pending" : "active";
        requests.unshift({ id, creatorId: viewerId, title, description, url: url.url, category: input.category, ask: input.ask, target: input.target, createdAt: new Date(), status, featured: false, completedAt: null });
        credit(viewerId, -config.requestCost, 0, "request", id);
        ctx.emit();
        return { id, status };
      }, 600),

    openSupport: (requestId, viewerId) =>
      ctx.later(() => {
        const r = reqOr(requestId);
        if (r.creatorId === viewerId) throw new SupportError("own-request");
        if (r.status !== "active") throw new SupportError("not-active");
        if (!visits.some((v) => v.requestId === requestId && v.userId === viewerId)) {
          visits.push({ requestId, userId: viewerId, openedAt: new Date(), confirmedAt: null, reaction: null, feedback: "", feedbackAt: null });
        }
        ctx.emit();
      }, 150),

    confirmSupport: (requestId, viewerId) =>
      ctx.later(() => {
        const r = reqOr(requestId);
        if (r.creatorId === viewerId) throw new SupportError("own-request");
        const v = visits.find((x) => x.requestId === requestId && x.userId === viewerId);
        if (!v) throw new SupportError("not-opened");
        if (v.confirmedAt) throw new SupportError("already-supported");
        if (r.status !== "active") throw new SupportError("not-active");
        if (Date.now() - v.openedAt.getTime() < config.minVisitSeconds * 1000) throw new SupportError("too-fast");
        v.confirmedAt = new Date();
        credit(viewerId, config.supportCredits, config.supportReputation, "support", requestId);
        if (supporters(requestId).length >= r.target) Object.assign(r, { status: "completed", completedAt: new Date() });
        ctx.emit();
        return { credits: config.supportCredits, reputation: config.supportReputation };
      }, 300),

    leaveFeedback: (requestId, viewerId, { reaction, text }) =>
      ctx.later(() => {
        const v = visits.find((x) => x.requestId === requestId && x.userId === viewerId && x.confirmedAt);
        if (!v) throw new SupportError("not-opened");
        if (v.feedbackAt) throw new SupportError("already-supported", "Feedback already sent");
        const body = text.trim();
        if (!reaction && !body) throw new SupportError("invalid", "Empty feedback");
        if (body.length > SUPPORT_LIMITS.feedbackMax) throw new SupportError("invalid", "Too long");
        Object.assign(v, { reaction, feedback: body, feedbackAt: new Date() });
        // Written feedback earns the bonus; a reaction alone is free.
        const earned = body.length >= 10 ? { credits: config.feedbackCredits, reputation: config.feedbackReputation } : { credits: 0, reputation: 0 };
        if (earned.credits || earned.reputation) credit(viewerId, earned.credits, earned.reputation, "feedback", requestId);
        ctx.emit();
        return earned;
      }, 300),

    listFeedback: (requestId, viewerId) =>
      ctx.later(() => {
        const r = reqOr(requestId);
        if (r.creatorId !== viewerId && !admins.has(viewerId)) return [];
        return visits
          .filter((v) => v.requestId === requestId && v.feedbackAt)
          .sort((a, b) => b.feedbackAt!.getTime() - a.feedbackAt!.getTime())
          .map((v): SupportFeedback => ({ id: `${v.requestId}:${v.userId}`, author: ctx.author(v.userId), reaction: v.reaction, text: v.feedback, createdAt: v.feedbackAt! }));
      }, 200),

    report: (requestId, viewerId, reason) =>
      ctx.later(() => {
        reqOr(requestId);
        if (reports.some((x) => x.requestId === requestId && x.reporterId === viewerId)) throw new SupportError("already-reported");
        reports.push({ id: `rep${++seq}`, requestId, reporterId: viewerId, reason: reason.trim().slice(0, 280) || "No reason given", at: new Date(), status: "open" });
        ctx.emit();
      }, 300),

    profileStats: (profileId) =>
      ctx.later(() => {
        const w = wallet(profileId);
        return {
          helpedCount: w.helpedCount,
          reputation: w.reputation,
          activeRequests: requests.filter((r) => r.creatorId === profileId && r.status === "active").length,
        };
      }, 200),
  };

  // ---------------------------------------------------------------- admin
  const VERIFICATION_TYPES: VerificationType[] = ["notable", "creator", "business", "organization", "amigo_team"];
  const toVerification = (id: string): Verification | null => {
    const v = ctx.verification.get(id);
    return v ? { type: v.type, note: v.note, verifiedAt: v.at, verifiedBy: v.by ? ctx.author(v.by) : null } : null;
  };

  const admin: AdminApi = {
    isAdmin: (viewerId) => ctx.later(() => admins.has(viewerId), 100),
    support: {
      listRequests: (adminId, status) =>
        ctx.later(() => {
          requireAdmin(adminId);
          return requests
            .filter((r) => status === "all" || r.status === status)
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
            .map((r) => toRequest(r, adminId));
        }, 200),

      moderate: (adminId, requestId, action: SupportAdminAction, note) =>
        ctx.later(() => {
          requireAdmin(adminId);
          const r = reqOr(requestId);
          const was = r.status;
          const allowed: Record<SupportAdminAction, SupportStatus[]> = {
            approve: ["pending", "rejected"],
            reject: ["pending"],
            remove: ["pending", "active", "completed", "closed"],
            close: ["active"],
            reopen: ["closed", "removed"],
            feature: ["active", "pending", "completed", "closed"],
            unfeature: ["active", "pending", "completed", "closed", "removed", "rejected"],
          };
          if (!allowed[action].includes(was)) throw new SupportError("invalid", `Can't ${action} a ${was} request`);
          if (action === "feature" || action === "unfeature") r.featured = action === "feature";
          else {
            r.status = action === "approve" || action === "reopen" ? (supporters(r.id).length >= r.target ? "completed" : "active") : action === "reject" ? "rejected" : action === "remove" ? "removed" : "closed";
            if (action === "remove" || action === "reject") r.featured = false;
            // A rejected request gets its credits back; a removed (spam) one does not.
            if (action === "reject") credit(r.creatorId, config.requestCost, 0, "refund", r.id);
          }
          audit(adminId, `support.${action}`, `${action} “${r.title}” (${was} → ${r.status}${r.featured ? ", featured" : ""})${note ? ` — ${note}` : ""}`);
          ctx.emit();
        }, 300),

      listReports: (adminId, status) =>
        ctx.later(() => {
          requireAdmin(adminId);
          return reports
            .filter((x) => status === "all" || x.status === "open")
            .sort((a, b) => b.at.getTime() - a.at.getTime())
            .map((x) => {
              const r = reqOr(x.requestId);
              return { id: x.id, request: { id: r.id, title: r.title, status: r.status }, reporter: ctx.author(x.reporterId), reason: x.reason, createdAt: x.at, status: x.status };
            });
        }, 200),

      resolveReport: (adminId, reportId, outcome) =>
        ctx.later(() => {
          requireAdmin(adminId);
          const rep = reports.find((x) => x.id === reportId);
          if (!rep) throw new SupportError("invalid");
          rep.status = outcome;
          audit(adminId, "support.report", `${outcome} report on “${reqOr(rep.requestId).title}”`);
          ctx.emit();
        }, 200),

      suspicious: (adminId) =>
        ctx.later(() => {
          requireAdmin(adminId);
          const out: SuspiciousSupport[] = [];
          const confirmed = visits.filter((v) => v.confirmedAt);
          for (const v of confirmed) {
            const secs = Math.round((v.confirmedAt!.getTime() - v.openedAt.getTime()) / 1000);
            if (secs < QUICK_CONFIRM_SECONDS) {
              out.push({ kind: "quick-confirm", person: ctx.author(v.userId), detail: `Confirmed “${reqOr(v.requestId).title}” ${secs}s after opening it`, requestId: v.requestId, at: v.confirmedAt! });
            }
          }
          for (const id of ctx.personIds()) {
            const times = confirmed.filter((v) => v.userId === id).map((v) => v.confirmedAt!.getTime()).sort((a, b) => a - b);
            for (let i = 0; i + BURST_COUNT <= times.length; i++) {
              if (times[i + BURST_COUNT - 1] - times[i] <= BURST_WINDOW_MIN * MIN) {
                out.push({ kind: "burst", person: ctx.author(id), detail: `${BURST_COUNT}+ supports within ${BURST_WINDOW_MIN} minutes`, requestId: null, at: new Date(times[i + BURST_COUNT - 1]) });
                break;
              }
            }
          }
          return out.sort((a, b) => b.at.getTime() - a.at.getTime());
        }, 250),

      supporters: (adminId, requestId) =>
        ctx.later(() => {
          requireAdmin(adminId);
          return visits
            .filter((v) => v.requestId === requestId)
            .sort((a, b) => b.openedAt.getTime() - a.openedAt.getTime())
            .map((v) => ({
              person: ctx.author(v.userId),
              openedAt: v.openedAt,
              confirmedAt: v.confirmedAt,
              seconds: v.confirmedAt ? Math.round((v.confirmedAt.getTime() - v.openedAt.getTime()) / 1000) : null,
            }));
        }, 200),

      findUser: (adminId, handle) =>
        ctx.later(() => {
          requireAdmin(adminId);
          const h = handle.trim().replace(/^@/, "").toLowerCase();
          const id = ctx.personIds().find((p) => ctx.handleOf(p) === h);
          return id ? { ...ctx.summary(id, adminId), wallet: wallet(id) } : null;
        }, 200),

      adjustCredits: (adminId, userId, delta, note) =>
        ctx.later(() => {
          requireAdmin(adminId);
          if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 1000) throw new SupportError("invalid", "Delta must be a whole number between -1000 and 1000");
          if (note.trim().length < 3) throw new SupportError("invalid", "Add a reason");
          if (balance(userId).credits + delta < 0) throw new SupportError("invalid", "Balance can't go below zero");
          credit(userId, delta, 0, "admin", null);
          audit(adminId, "support.credits", `${delta > 0 ? "+" : ""}${delta} credits for @${ctx.handleOf(userId)} — ${note.trim()}`);
          ctx.emit();
        }, 300),

      audit: (adminId, limit) =>
        ctx.later(() => {
          requireAdmin(adminId);
          return auditLog.slice(0, limit).map((a): AdminAuditEntry => ({ id: a.id, admin: ctx.author(a.adminId), action: a.action, summary: a.summary, createdAt: a.at }));
        }, 150),
    },

    users: {
      find: (adminId, handle) =>
        ctx.later(() => {
          requireAdmin(adminId);
          const h = handle.trim().replace(/^@/, "").toLowerCase();
          const id = ctx.personIds().find((p) => ctx.handleOf(p) === h);
          return id ? { person: ctx.summary(id, adminId), verification: toVerification(id) } : null;
        }, 200),

      verify: (adminId, userId, type, note) =>
        ctx.later(() => {
          requireAdmin(adminId);
          if (!VERIFICATION_TYPES.includes(type)) throw new SupportError("invalid", "Unknown verification type");
          const was = ctx.verification.get(userId);
          ctx.verification.set(userId, { type, note: note.trim().slice(0, 280), at: new Date(), by: adminId });
          audit(adminId, "user.verify", `${was ? "changed verification of" : "verified"} @${ctx.handleOf(userId)} as ${type}${note.trim() ? ` — ${note.trim()}` : ""}`);
          ctx.emit();
        }, 300),

      unverify: (adminId, userId, note) =>
        ctx.later(() => {
          requireAdmin(adminId);
          if (!ctx.verification.get(userId)) throw new SupportError("invalid", "Not verified");
          ctx.verification.set(userId, null);
          audit(adminId, "user.unverify", `removed verification from @${ctx.handleOf(userId)}${note.trim() ? ` — ${note.trim()}` : ""}`);
          ctx.emit();
        }, 300),

      listVerified: (adminId) =>
        ctx.later(() => {
          requireAdmin(adminId);
          return ctx
            .personIds()
            .filter((id) => ctx.verification.get(id))
            .map((id) => ({ person: ctx.summary(id, adminId), verification: toVerification(id)! }));
        }, 200),
    },
  };

  const refill = <T,>(target: T[], from: T[]) => target.splice(0, target.length, ...from);
  type Saved = { requests: RequestRecord[]; visits: VisitRecord[]; ledger: LedgerRecord[]; reports: typeof reports; auditLog: typeof auditLog; seq: number };

  return {
    api,
    admin,
    /** Shared admin audit log (other features log their admin actions here too). */
    audit,
    /** Demo persistence (demoPersist.ts). */
    persist: {
      export: (): Saved => ({ requests, visits, ledger, reports, auditLog, seq }),
      import: (s: Saved) => {
        refill(requests, s.requests);
        refill(visits, s.visits);
        refill(ledger, s.ledger);
        refill(reports, s.reports);
        refill(auditLog, s.auditLog);
        seq = s.seq;
      },
    },
    hooks: {
      /** Make someone else support a request (opened `secondsAgo` ago, confirmed now). */
      support(userId: string, requestId: string, secondsAgo = 120) {
        const r = reqOr(requestId);
        if (r.creatorId === userId || visits.some((v) => v.requestId === requestId && v.userId === userId && v.confirmedAt)) return false;
        visits.push({ requestId, userId, openedAt: new Date(Date.now() - secondsAgo * 1000), confirmedAt: new Date(), reaction: null, feedback: "", feedbackAt: null });
        credit(userId, config.supportCredits, config.supportReputation, "support", requestId);
        if (supporters(requestId).length >= r.target) Object.assign(r, { status: "completed", completedAt: new Date() });
        ctx.emit();
        return true;
      },
      /** Pretend the viewer opened a request's link `seconds` earlier (skip the wait in tests). */
      backdateVisit(userId: string, requestId: string, seconds: number) {
        const v = visits.find((x) => x.requestId === requestId && x.userId === userId);
        if (v) v.openedAt = new Date(v.openedAt.getTime() - seconds * 1000);
      },
      wallet: (userId: string) => wallet(userId),
    },
  };
}
