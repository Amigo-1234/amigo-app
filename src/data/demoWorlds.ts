/**
 * Worlds for the in-memory demo source. Same rules as the Supabase migration
 * (20261006160000_worlds.sql): admin-created Worlds only, join until the end,
 * post/chat only while live and only after joining, entries only in
 * competition Worlds before entries close (up to the entry limit), and points
 * computed from likes/replies by other people made before the World ended.
 */
import type {
  Author,
  LeaderboardEntry,
  MediaItem,
  PersonSummary,
  Post,
  Subscription,
  Viewer,
  World,
  WorldChatMessage,
  WorldCompetition,
  WorldsApi,
} from "./types";
import { WORLD_CHAT_MAX_LENGTH, WorldError } from "./types";

/** The post fields Worlds need from the demo's post records. */
export interface WorldPostRecord {
  id: string;
  authorId: string;
  text: string;
  createdAt: Date;
  baseLikes: number;
  likers: Set<string>;
  likedAt?: Map<string, Date>;
  parentId: string | null;
  worldId?: string | null;
  entry?: boolean;
}

export interface DemoContext {
  records: () => WorldPostRecord[];
  addRecord: (r: WorldPostRecord & { media: MediaItem[] }) => void;
  personIds: () => string[];
  author: (id: string) => Author;
  summary: (id: string, viewerId: string) => PersonSummary;
  follows: (a: string, b: string) => boolean;
  toPost: (r: WorldPostRecord) => Post;
  emit: () => void;
  watch: <T>(sub: Subscription<T>, read: () => T) => () => void;
  later: <T>(fn: () => T, ms?: number) => Promise<T>;
  img: (seed: string, w: number, h: number) => MediaItem;
  scenario: string | null;
}

interface WorldRecord {
  id: string;
  slug: string;
  title: string;
  tagline: string;
  description: string;
  coverUrl: string | null;
  startsAt: Date;
  endsAt: Date;
  /** People outside the demo cast, to make counts realistic. */
  baseParticipants: number;
  members: Set<string>;
  competition: WorldCompetition | null;
  hostPicks: Set<string>;
  chat: WorldChatMessage[];
}

const MIN = 60_000;
const HOUR = 60 * MIN;

export function createDemoWorlds(ctx: DemoContext) {
  const now = Date.now();
  const at = (offsetMs: number) => new Date(now + offsetMs);

  const worlds: WorldRecord[] = [
    {
      id: "w-rage",
      slug: "rage-bait-night",
      title: "Rage Bait Night",
      tagline: "Post your most outrageous (harmless) hot take. Most reactions wins.",
      description:
        "One night only. Drop your spiciest take — food, music, group chats, anything but people. Likes and replies on your entry earn points; Amigo picks a few favourites for a bonus. Keep it playful: no insults, no targeting anyone.",
      coverUrl: "https://picsum.photos/seed/amigo-rage/1200/600",
      startsAt: at(-40 * MIN),
      endsAt: at(80 * MIN),
      baseParticipants: 312,
      members: new Set(["ama", "leo", "kofi", "zoe", "tomi", "mira", "jun"]),
      competition: {
        scoring: { reaction: 1, reply: 2, hostPick: 15 },
        entriesCloseAt: at(35 * MIN),
        entryLimit: 1,
        prize: "Rage Bait Champion title for a week and a spot on Explore",
      },
      hostPicks: new Set(["we-zoe"]),
      chat: [],
    },
    {
      id: "w-derby",
      slug: "derby-watch-party",
      title: "Derby Watch Party",
      tagline: "Watch the big match together. Live reactions, zero spoilers.",
      description: "Bring snacks and opinions. We'll open the World at kick-off and keep it going through the final whistle.",
      coverUrl: "https://picsum.photos/seed/amigo-derby/1200/600",
      startsAt: at(3 * HOUR),
      endsAt: at(5 * HOUR),
      baseParticipants: 128,
      members: new Set(["kofi", "tomi", "leo"]),
      competition: null,
      hostPicks: new Set(),
      chat: [],
    },
    {
      id: "w-debate",
      slug: "debate-night",
      title: "Debate Night",
      tagline: "Pick a side, make your case in one post. The room decides.",
      description:
        "This week's motion: “Breakfast for dinner is better than dinner.” Post one argument as your entry. Replies count double, so make people want to answer.",
      coverUrl: "https://picsum.photos/seed/amigo-debate/1200/600",
      startsAt: at(2 * 24 * HOUR),
      endsAt: at(2 * 24 * HOUR + 2 * HOUR),
      baseParticipants: 54,
      members: new Set(["ama", "rosa"]),
      competition: {
        scoring: { reaction: 1, reply: 2, hostPick: 0 },
        entriesCloseAt: at(2 * 24 * HOUR + 75 * MIN),
        entryLimit: 1,
        prize: "Debate Night winner badge on your profile (coming soon)",
      },
      hostPicks: new Set(),
      chat: [],
    },
    {
      id: "w-games",
      slug: "game-night",
      title: "Game Night",
      tagline: "Show us your best clip, high score or wildest board-game moment.",
      description: "Share one moment from your gaming week. The community voted with likes and replies.",
      coverUrl: "https://picsum.photos/seed/amigo-games/1200/600",
      startsAt: at(-27 * HOUR),
      endsAt: at(-24 * HOUR),
      baseParticipants: 201,
      members: new Set(["me", "kofi", "jun", "zoe", "leo", "tomi"]),
      competition: {
        scoring: { reaction: 1, reply: 2, hostPick: 10 },
        entriesCloseAt: at(-25 * HOUR),
        entryLimit: 1,
        prize: "Game Night trophy",
      },
      hostPicks: new Set(["wg-kofi"]),
      chat: [],
    },
    {
      id: "w-walk",
      slug: "sunday-photo-walk",
      title: "Sunday Photo Walk",
      tagline: "Go outside, take one photo, share it here.",
      description: "A slow one. Walk somewhere, notice something, post it.",
      coverUrl: "https://picsum.photos/seed/amigo-walk/1200/600",
      startsAt: at(-5 * 24 * HOUR),
      endsAt: at(-5 * 24 * HOUR + 4 * HOUR),
      baseParticipants: 46,
      members: new Set(["ama", "zoe", "rosa"]),
      competition: null,
      hostPicks: new Set(),
      chat: [],
    },
  ];
  const byId = (id: string) => worlds.find((w) => w.id === id);

  // ---------------------------------------------------------------- seed posts
  const seedPost = (id: string, worldId: string, authorId: string, text: string, minutesAgo: number, baseLikes: number, opts: { entry?: boolean; likers?: string[]; parentId?: string; media?: MediaItem[] } = {}) => {
    const createdAt = new Date(now - minutesAgo * MIN);
    const likers = opts.likers ?? [];
    ctx.addRecord({
      id, authorId, text, createdAt, baseLikes, media: opts.media ?? [],
      likers: new Set(likers), likedAt: new Map(likers.map((u) => [u, new Date(createdAt.getTime() + MIN)])),
      parentId: opts.parentId ?? null, worldId, entry: Boolean(opts.entry),
    });
  };
  // Rage Bait Night (live)
  seedPost("we-kofi", "w-rage", "kofi", "Pineapple on jollof is elite. I will not be taking questions.", 34, 21, { entry: true, likers: ["ama", "leo", "tomi"] });
  seedPost("we-zoe", "w-rage", "zoe", "Croissants are overrated. Buttered toast is the superior breakfast.", 31, 12, { entry: true, likers: ["mira"] });
  seedPost("we-leo", "w-rage", "leo", "Group chats should have a three-message limit per person per day.", 26, 17, { entry: true, likers: ["jun", "kofi"] });
  seedPost("we-tomi", "w-rage", "tomi", "Cold pizza is better than hot pizza. Always.", 22, 9, { entry: true });
  seedPost("we-mira", "w-rage", "mira", "Remixes are better than the originals. Every single time.", 18, 14, { entry: true, likers: ["zoe"] });
  seedPost("wr-ama", "w-rage", "ama", "This World is chaos and I love it. Snapped the room tonight.", 28, 6, { media: [ctx.img("amigo-rage-room", 1600, 1067)] });
  seedPost("wr-jun", "w-rage", "jun", "First World! Who's winning so far?", 12, 2);
  seedPost("wrr-1", "w-rage", "ama", "Kofi, this is a crime and I respect it", 30, 3, { parentId: "we-kofi" });
  seedPost("wrr-2", "w-rage", "tomi", "Pineapple belongs nowhere near rice. Next.", 29, 5, { parentId: "we-kofi" });
  seedPost("wrr-3", "w-rage", "rosa", "Toast slander will not be tolerated", 27, 2, { parentId: "we-zoe" });
  seedPost("wrr-4", "w-rage", "mira", "Three is generous honestly", 20, 1, { parentId: "we-leo" });
  seedPost("wrr-5", "w-rage", "leo", "Who hurt you, Tomi", 15, 4, { parentId: "we-tomi" });
  // Game Night (finished)
  seedPost("wg-kofi", "w-games", "kofi", "Last-second comeback in our five-a-side video game league. Screaming.", 26 * 60 + 40, 44, { entry: true, likers: ["jun", "zoe", "leo"], media: [ctx.img("amigo-gamenight1", 1600, 900)] });
  seedPost("wg-jun", "w-games", "jun", "Finally beat my brother at chess after 41 losses.", 26 * 60 + 20, 38, { entry: true, likers: ["kofi", "tomi"] });
  seedPost("wg-zoe", "w-games", "zoe", "Board game night got so competitive we had to take a break.", 26 * 60, 25, { entry: true, likers: ["leo"], media: [ctx.img("amigo-gamenight2", 1080, 1350)] });
  seedPost("wgr-1", "w-games", "tomi", "41 losses is dedication", 25 * 60 + 50, 3, { parentId: "wg-jun" });
  seedPost("wgr-2", "w-games", "leo", "The comeback was unreal", 25 * 60 + 30, 2, { parentId: "wg-kofi" });
  // Sunday Photo Walk (finished, no competition)
  seedPost("ww-ama", "w-walk", "ama", "Found this corner on the way to the market.", 5 * 24 * 60 - 60, 51, { media: [ctx.img("amigo-walk1", 1080, 1350)] });
  seedPost("ww-zoe", "w-walk", "zoe", "Rain, again. Still pretty.", 5 * 24 * 60 - 90, 33, { media: [ctx.img("amigo-walk2", 1600, 1067)] });

  // ----------------------------------------------------------------- seed chat
  let chatSeq = 0;
  const say = (worldId: string, authorId: string, text: string, minutesAgo: number) =>
    byId(worldId)!.chat.push({ id: `c${++chatSeq}`, author: ctx.author(authorId), text, createdAt: new Date(now - minutesAgo * MIN) });
  say("w-rage", "tomi", "we're live!! drop your takes", 39);
  say("w-rage", "kofi", "I came prepared", 36);
  say("w-rage", "zoe", "Kofi I'm scared of what you're about to post", 35);
  say("w-rage", "ama", "the pineapple one 😭", 33);
  say("w-rage", "leo", "Reminder: entries close in about an hour, one each", 25);
  say("w-rage", "mira", "is it rage bait if it's just true though", 19);
  say("w-rage", "jun", "first time here, this is fun", 11);
  say("w-rage", "kofi", "Zoë got an Amigo pick?? robbery", 6);
  say("w-games", "kofi", "GG everyone", 24 * 60 + 10);
  say("w-games", "jun", "that was the best one yet", 24 * 60 + 5);

  // Demo-only: a gentle trickle of chat in live Worlds so the preview feels alive.
  const lines = ["this is unhinged 😂", "ok that one got me", "who's leading now?", "replying to everything rn", "Amigo pick incoming?", "new take just dropped"];
  let quiet = false;
  let trickle: ReturnType<typeof setInterval> | undefined;
  let chatSubscribers = 0;
  const startTrickle = () => {
    if (trickle || ctx.scenario) return;
    trickle = setInterval(() => {
      if (quiet) return;
      const live = worlds.filter((w) => status(w) === "live");
      for (const w of live) {
        const pool = [...w.members].filter((m) => m !== "me");
        if (!pool.length) continue;
        w.chat.push({ id: `c${++chatSeq}`, author: ctx.author(pool[Math.floor(Math.random() * pool.length)]), text: lines[Math.floor(Math.random() * lines.length)], createdAt: new Date() });
      }
      ctx.emit();
    }, 30_000);
  };
  const stopTrickle = () => {
    clearInterval(trickle);
    trickle = undefined;
  };

  // ------------------------------------------------------------------- rules
  function status(w: WorldRecord, t = Date.now()) {
    return t < w.startsAt.getTime() ? "upcoming" : t < w.endsAt.getTime() ? "live" : "finished";
  }

  function toWorld(w: WorldRecord, viewerId: string): World {
    const members = [...w.members];
    const preview = [
      ...members.filter((m) => m !== viewerId && ctx.follows(viewerId, m)),
      ...members.filter((m) => m !== viewerId && !ctx.follows(viewerId, m)),
    ].slice(0, 3);
    return {
      id: w.id,
      slug: w.slug,
      title: w.title,
      tagline: w.tagline,
      description: w.description,
      coverUrl: w.coverUrl,
      startsAt: w.startsAt,
      endsAt: w.endsAt,
      participantCount: w.baseParticipants + w.members.size,
      viewerJoined: w.members.has(viewerId),
      participantsPreview: preview.map(ctx.author),
      competition: w.competition,
    };
  }

  function leaderboard(w: WorldRecord, viewerId: string): LeaderboardEntry[] {
    if (!w.competition) return [];
    const { reaction, reply, hostPick } = w.competition.scoring;
    const end = w.endsAt.getTime();
    const all = ctx.records();
    const totals = new Map<string, { points: number; entries: number; first: number }>();
    for (const e of all.filter((r) => r.worldId === w.id && r.entry)) {
      const likes = e.baseLikes + [...(e.likedAt ?? new Map<string, Date>())].filter(([u, t]) => u !== e.authorId && t.getTime() <= end && e.likers.has(u)).length;
      const replies = all.filter((r) => r.parentId === e.id && r.authorId !== e.authorId && r.createdAt.getTime() <= end).length;
      const pts = likes * reaction + replies * reply + (w.hostPicks.has(e.id) ? hostPick : 0);
      const t = totals.get(e.authorId) ?? { points: 0, entries: 0, first: Infinity };
      totals.set(e.authorId, { points: t.points + pts, entries: t.entries + 1, first: Math.min(t.first, e.createdAt.getTime()) });
    }
    return [...totals]
      .sort(([a, x], [b, y]) => y.points - x.points || x.first - y.first || a.localeCompare(b))
      .map(([id, t], i) => ({ rank: i + 1, person: ctx.author(id), points: t.points, entries: t.entries, viewerFollows: ctx.follows(viewerId, id) }));
  }

  const worldOrError = (id: string) => {
    const w = byId(id);
    if (!w) throw new WorldError("unknown", "No such World");
    return w;
  };

  /** Called by the demo createPost for input.world. Throws WorldError like the database trigger. */
  function checkPost(worldId: string, authorId: string, entry: boolean) {
    const w = worldOrError(worldId);
    if (status(w) !== "live") throw new WorldError("not-live");
    if (!w.members.has(authorId)) throw new WorldError("not-joined");
    if (entry) {
      if (!w.competition) throw new WorldError("not-competition");
      if (Date.now() >= w.competition.entriesCloseAt.getTime()) throw new WorldError("entries-closed");
      const mine = ctx.records().filter((r) => r.worldId === w.id && r.entry && r.authorId === authorId).length;
      if (mine >= w.competition.entryLimit) throw new WorldError("entry-limit");
    }
  }

  const failIfError = () => {
    if (ctx.scenario === "error") throw new Error("Demo network error");
  };

  const api: WorldsApi = {
    listWorlds: (viewerId) =>
      ctx.later(() => {
        failIfError();
        return ctx.scenario === "empty" ? [] : worlds.map((w) => toWorld(w, viewerId));
      }),

    subscribeWorld(slug, viewerId, sub) {
      return ctx.watch(sub, () => {
        const w = worlds.find((x) => x.slug === slug);
        return w ? toWorld(w, viewerId) : null;
      });
    },

    join: (worldId, viewerId) =>
      ctx.later(() => {
        const w = worldOrError(worldId);
        if (status(w) === "finished") throw new WorldError("not-live", "This World has ended");
        w.members.add(viewerId);
        ctx.emit();
      }, 300),

    leave: (worldId, viewerId) =>
      ctx.later(() => {
        const w = worldOrError(worldId);
        if (status(w) === "finished") throw new WorldError("not-live", "This World has ended");
        w.members.delete(viewerId);
        ctx.emit();
      }, 300),

    subscribeWorldPosts(worldId, _viewerId, { entriesOnly, limit }, sub) {
      return ctx.watch(sub, () => {
        const list = ctx
          .records()
          .filter((r) => r.worldId === worldId && !r.parentId && (!entriesOnly || r.entry))
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        return { posts: list.slice(0, limit).map(ctx.toPost), hasMore: list.length > limit };
      });
    },

    subscribeLeaderboard(worldId, viewerId, sub) {
      return ctx.watch(sub, () => leaderboard(worldOrError(worldId), viewerId));
    },

    subscribeChat(worldId, limit, sub) {
      chatSubscribers++;
      startTrickle();
      const stop = ctx.watch(sub, () => worldOrError(worldId).chat.slice(-limit));
      return () => {
        stop();
        if (--chatSubscribers === 0) stopTrickle();
      };
    },

    sendChat: (worldId, viewer: Viewer, text) =>
      ctx.later(() => {
        const w = worldOrError(worldId);
        const body = text.trim();
        if (status(w) !== "live") throw new WorldError("not-live");
        if (!w.members.has(viewer.id)) throw new WorldError("not-joined");
        if (!body || body.length > WORLD_CHAT_MAX_LENGTH) throw new WorldError("unknown", "Message is empty or too long");
        w.chat.push({ id: `c${++chatSeq}`, author: ctx.author(viewer.id), text: body, createdAt: new Date() });
        ctx.emit();
      }, 200),

    listParticipants: (worldId, viewerId, limit) =>
      ctx.later(() => {
        const ids = [...worldOrError(worldId).members].filter((m) => m !== viewerId);
        return [...ids.filter((m) => !ctx.follows(viewerId, m)), ...ids.filter((m) => ctx.follows(viewerId, m))]
          .slice(0, limit)
          .map((id) => ctx.summary(id, viewerId));
      }),
  };

  return {
    api,
    checkPost,
    worldInfo: (worldId: string | null | undefined) => {
      const w = worldId ? byId(worldId) : undefined;
      return w ? { slug: w.slug, title: w.title } : null;
    },
    /** Test/demo hooks. */
    hooks: {
      chat(actorId: string, slug: string, text: string) {
        const w = worlds.find((x) => x.slug === slug)!;
        w.chat.push({ id: `c${++chatSeq}`, author: ctx.author(actorId), text, createdAt: new Date() });
        ctx.emit();
      },
      joinWorld(actorId: string, slug: string) {
        worlds.find((x) => x.slug === slug)!.members.add(actorId);
        ctx.emit();
      },
      /** Shift a World's times (ms) — lets tests watch it go live or end. */
      shiftWorld(slug: string, ms: number) {
        const w = worlds.find((x) => x.slug === slug)!;
        w.startsAt = new Date(w.startsAt.getTime() + ms);
        w.endsAt = new Date(w.endsAt.getTime() + ms);
        if (w.competition) w.competition = { ...w.competition, entriesCloseAt: new Date(w.competition.entriesCloseAt.getTime() + ms) };
        ctx.emit();
      },
      quiet(on = true) {
        quiet = on;
      },
    },
  };
}
