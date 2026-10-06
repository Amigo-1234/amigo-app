/**
 * Moments for the in-memory demo source. Same rules as the Supabase migration
 * (20261006220000_moments.sql): gone 24 hours after posting, "followers" only
 * for people who follow the author, authors can delete their own, admins can
 * take one down (audit-logged), viewers + reactions visible to the author only.
 *
 * The seeded Moments are created relative to page load (so the demo always
 * has fresh ones); what you post, see and react to is saved with the demo state.
 * Other demo people "view" (and sometimes react to) what you post.
 */
import type {
  Author,
  MediaItem,
  Moment,
  MomentAudience,
  MomentBackground,
  MomentGroup,
  MomentReport,
  MomentsAdminApi,
  MomentsApi,
  MomentViewer,
  MessageReportReason,
  NewMediaInput,
  Subscription,
} from "./types";
import { groupMoments } from "./momentGroups";
import { MOMENT_LIFETIME_MS, MOMENT_TEXT_MAX_LENGTH, MomentError, SupportError } from "./types";

export interface MomentsContext {
  author: (id: string) => Author;
  follows: (a: string, b: string) => boolean;
  emit: () => void;
  watch: <T>(sub: Subscription<T>, read: () => T) => () => void;
  later: <T>(fn: () => T, ms?: number) => Promise<T>;
  img: (seed: string, w: number, h: number) => MediaItem;
  upload: (m: NewMediaInput) => MediaItem;
  isAdmin: (id: string) => boolean;
  handleOf: (id: string) => string;
  audit: (adminId: string, action: string, summary: string) => void;
}

interface MomentRecord {
  id: string;
  authorId: string;
  text: string;
  background: MomentBackground;
  media: MediaItem | null;
  audience: MomentAudience;
  createdAt: Date;
  removedAt: Date | null;
}

interface ReportRecord {
  id: string;
  momentId: string;
  reporterId: string;
  reason: MessageReportReason;
  note: string;
  status: "open" | "reviewed";
  createdAt: Date;
}

const HOUR = 60 * 60 * 1000;

export function createDemoMoments(ctx: MomentsContext) {
  const ago = (ms: number) => new Date(Date.now() - ms);
  const seed = (id: string, authorId: string, hoursAgo: number, text: string, background: MomentBackground, media: MediaItem | null, audience: MomentAudience = "everyone"): MomentRecord =>
    ({ id, authorId, text, background, media, audience, createdAt: ago(hoursAgo * HOUR), removedAt: null });

  /** Fresh on every load, so the demo never runs dry. */
  const seeded: MomentRecord[] = [
    seed("mo-mira-1", "mira", 2.5, "", "night", ctx.img("amigo-moment-studio", 1080, 1920)),
    seed("mo-mira-2", "mira", 1, "New track drops tonight 🎧", "night", null),
    seed("mo-ama-1", "ama", 6, "", "coral", ctx.img("amigo-moment-roof", 1080, 1920)),
    seed("mo-ama-2", "ama", 3, "golden hour, again", "sunset", ctx.img("amigo-moment-gold", 1080, 1350)),
    seed("mo-leo-1", "leo", 9, "Who's up for a hike on Saturday?", "forest", null, "followers"),
    seed("mo-zoe-1", "zoe", 20, "", "plain", ctx.img("amigo-moment-paris", 1080, 1920)),
    seed("mo-tomi-1", "tomi", 23, "Drink some water 💧", "ocean", null),
    // Followers only, and you don't follow Kofi: you never see this one.
    seed("mo-kofi-1", "kofi", 4, "Match tonight — who's in?", "sunset", null, "followers"),
  ];
  let mine: MomentRecord[] = [];
  /** momentId → viewerId → when */
  const views = new Map<string, Map<string, Date>>([["mo-zoe-1", new Map([["me", ago(2 * HOUR)]])]]);
  /** momentId → viewerId → emoji */
  const reactions = new Map<string, Map<string, string>>();
  let reports: ReportRecord[] = [];
  const removed = new Map<string, Date>();
  let seq = 0;

  const all = () => [...seeded, ...mine].map((m) => (removed.has(m.id) ? { ...m, removedAt: removed.get(m.id)! } : m));
  const live = (m: MomentRecord) => !m.removedAt && m.createdAt.getTime() + MOMENT_LIFETIME_MS > Date.now();
  const canSee = (m: MomentRecord, viewerId: string) =>
    live(m) && (m.authorId === viewerId || m.audience === "everyone" || ctx.follows(viewerId, m.authorId));

  function toMoment(m: MomentRecord, viewerId: string): Moment {
    return {
      id: m.id,
      author: ctx.author(m.authorId),
      text: m.text,
      background: m.background,
      media: m.media,
      audience: m.audience,
      createdAt: m.createdAt,
      expiresAt: new Date(m.createdAt.getTime() + MOMENT_LIFETIME_MS),
      seen: m.authorId === viewerId || !!views.get(m.id)?.has(viewerId),
      viewerReaction: reactions.get(m.id)?.get(viewerId) ?? null,
      viewCount: m.authorId === viewerId ? (views.get(m.id)?.size ?? 0) : undefined,
    };
  }

  const feed = (viewerId: string): MomentGroup[] =>
    groupMoments(all().filter((m) => canSee(m, viewerId)).map((m) => toMoment(m, viewerId)), viewerId);

  const find = (id: string) => all().find((m) => m.id === id);
  const visible = (id: string, viewerId: string) => {
    const m = find(id);
    if (!m || !canSee(m, viewerId)) throw new MomentError("not-found");
    return m;
  };

  /** The demo cast notices what you post. */
  function simulateAudience(id: string) {
    const fans: [string, number, string | null][] = [["leo", 2500, null], ["ama", 4500, "❤️"], ["mira", 7000, "🔥"]];
    for (const [who, at, emoji] of fans) {
      setTimeout(() => {
        const m = find(id);
        if (!m || !canSee(m, who)) return;
        if (!views.has(id)) views.set(id, new Map());
        views.get(id)!.set(who, new Date());
        if (emoji) {
          if (!reactions.has(id)) reactions.set(id, new Map());
          reactions.get(id)!.set(who, emoji);
        }
        ctx.emit();
      }, at);
    }
  }

  const api: MomentsApi = {
    subscribeFeed: (viewerId, sub) => ctx.watch(sub, () => feed(viewerId)),

    forAuthor: (authorId, viewerId) =>
      ctx.later(() => feed(viewerId).find((g) => g.author.id === authorId)?.moments ?? [], 150),

    create: (viewer, input) =>
      ctx.later(() => {
        const text = input.text.trim();
        if (!text && !input.image) throw new MomentError("empty");
        if (text.length > MOMENT_TEXT_MAX_LENGTH) throw new MomentError("too-long");
        const m: MomentRecord = {
          id: `mo${Date.now().toString(36)}${(seq++).toString(36)}`,
          authorId: viewer.id,
          text,
          background: input.background,
          media: input.image ? ctx.upload(input.image) : null,
          audience: input.audience,
          createdAt: new Date(),
          removedAt: null,
        };
        mine = [...mine, m];
        ctx.emit();
        simulateAudience(m.id);
        return { id: m.id };
      }, input.image ? 800 : 400),

    delete: (viewerId, id) =>
      ctx.later(() => {
        const m = find(id);
        if (!m || m.authorId !== viewerId) throw new MomentError("not-allowed");
        mine = mine.filter((x) => x.id !== id);
        views.delete(id);
        reactions.delete(id);
        ctx.emit();
      }, 300),

    markSeen: (viewerId, id) =>
      ctx.later(() => {
        const m = visible(id, viewerId);
        if (m.authorId === viewerId) return;
        if (!views.has(id)) views.set(id, new Map());
        if (!views.get(id)!.has(viewerId)) {
          views.get(id)!.set(viewerId, new Date());
          ctx.emit();
        }
      }, 80),

    react: (viewerId, id, emoji) =>
      ctx.later(() => {
        const m = visible(id, viewerId);
        if (m.authorId === viewerId) throw new MomentError("not-allowed");
        if (!reactions.has(id)) reactions.set(id, new Map());
        if (emoji) reactions.get(id)!.set(viewerId, emoji);
        else reactions.get(id)!.delete(viewerId);
        if (!views.has(id)) views.set(id, new Map());
        if (!views.get(id)!.has(viewerId)) views.get(id)!.set(viewerId, new Date());
        ctx.emit();
      }, 150),

    viewers: (viewerId, id) =>
      ctx.later((): MomentViewer[] => {
        const m = find(id);
        if (!m || m.authorId !== viewerId) throw new MomentError("not-allowed");
        return [...(views.get(id) ?? new Map<string, Date>()).entries()]
          .sort((a, b) => b[1].getTime() - a[1].getTime())
          .map(([who, at]) => ({ person: ctx.author(who), viewedAt: at, reaction: reactions.get(id)?.get(who) ?? null }));
      }, 200),

    report: (viewerId, id, input) =>
      ctx.later(() => {
        const m = visible(id, viewerId);
        if (m.authorId === viewerId) throw new MomentError("not-allowed");
        reports = [
          ...reports,
          { id: `mr${(seq++).toString(36)}`, momentId: id, reporterId: viewerId, reason: input.reason, note: input.note.trim().slice(0, 500), status: "open", createdAt: new Date() },
        ];
        ctx.emit();
      }, 300),
  };

  const requireAdmin = (id: string) => {
    if (!ctx.isAdmin(id)) throw new SupportError("not-admin", "Admins only");
  };

  const admin: MomentsAdminApi = {
    listReports: (adminId) =>
      ctx.later((): MomentReport[] => {
        requireAdmin(adminId);
        return [...reports]
          .sort((a, b) => Number(b.status === "open") - Number(a.status === "open") || b.createdAt.getTime() - a.createdAt.getTime())
          .map((r) => {
            const m = find(r.momentId);
            const still = m && (m.removedAt || m.createdAt.getTime() + MOMENT_LIFETIME_MS > Date.now());
            return {
              id: r.id,
              reporter: { id: r.reporterId, handle: ctx.handleOf(r.reporterId) },
              reason: r.reason,
              note: r.note,
              status: r.status,
              createdAt: r.createdAt,
              moment: m && still
                ? { id: m.id, author: ctx.author(m.authorId), text: m.text, media: m.media, background: m.background, createdAt: m.createdAt, removed: !!m.removedAt }
                : null,
            };
          });
      }),

    remove: (adminId, momentId, note) =>
      ctx.later(() => {
        requireAdmin(adminId);
        const m = find(momentId);
        if (!m) throw new SupportError("invalid", "No such Moment");
        removed.set(momentId, new Date());
        reports = reports.map((r) => (r.momentId === momentId ? { ...r, status: "reviewed" } : r));
        ctx.audit(adminId, "moment.remove", `removed a Moment by @${ctx.handleOf(m.authorId)}${note.trim() ? ` — ${note.trim()}` : ""}`);
        ctx.emit();
      }, 300),

    setReportStatus: (adminId, reportId, status) =>
      ctx.later(() => {
        requireAdmin(adminId);
        reports = reports.map((r) => (r.id === reportId ? { ...r, status } : r));
        ctx.audit(adminId, status === "reviewed" ? "moment_report.reviewed" : "moment_report.reopened", `${status === "reviewed" ? "dismissed" : "reopened"} a Moment report`);
        ctx.emit();
      }, 200),
  };

  type Saved = { mine: MomentRecord[]; views: [string, [string, Date][]][]; reactions: [string, [string, string][]][]; reports: ReportRecord[]; removed: [string, Date][]; seq: number };

  return {
    api,
    admin,
    hooks: {
      /** Someone posts a Moment (e.g. __amigoDemo.moments.post("rosa", "Hello")). */
      post(authorId: string, text: string, background: MomentBackground = "coral", hoursAgo = 0) {
        mine = [...mine, { id: `mo${Date.now().toString(36)}${(seq++).toString(36)}`, authorId, text, background, media: null, audience: "everyone", createdAt: ago(hoursAgo * HOUR), removedAt: null }];
        ctx.emit();
      },
      report(reporterId: string, momentId: string) {
        reports = [...reports, { id: `mr${(seq++).toString(36)}`, momentId, reporterId, reason: "inappropriate", note: "", status: "open", createdAt: new Date() }];
        ctx.emit();
      },
      count: (viewerId = "me") => feed(viewerId).reduce((n, g) => n + g.moments.length, 0),
    },
    persist: {
      export: (saveMedia: (m: MediaItem) => unknown): Saved => ({
        mine: mine.map((m) => ({ ...m, media: m.media ? (saveMedia(m.media) as MediaItem) : null })),
        views: [...views.entries()].map(([k, v]) => [k, [...v.entries()]]),
        reactions: [...reactions.entries()].map(([k, v]) => [k, [...v.entries()]]),
        reports,
        removed: [...removed.entries()],
        seq,
      }),
      import: (s: Saved, loadMedia: (m: never) => MediaItem) => {
        mine = s.mine.map((m) => ({ ...m, media: m.media ? loadMedia(m.media as never) : null }));
        views.clear();
        s.views.forEach(([k, v]) => views.set(k, new Map(v)));
        reactions.clear();
        s.reactions.forEach(([k, v]) => reactions.set(k, new Map(v)));
        reports = s.reports;
        removed.clear();
        s.removed.forEach(([k, v]) => removed.set(k, v));
        seq = s.seq;
      },
    },
  };
}
