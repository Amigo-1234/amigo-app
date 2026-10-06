/**
 * In-memory data source for UI development (`npm run dev:demo`).
 * Never bundled into production builds unless VITE_DATA_SOURCE=demo.
 *
 * Preview states with a query param: ?demo=loading | empty | error | slow | signedout
 */
import type {
  Author,
  DataSource,
  MediaItem,
  PersonSummary,
  Post,
  Profile,
  ProfileTab,
  ProfileUpdate,
  Reply,
  Subscription,
  Viewer,
} from "./types";
import { HANDLE_PATTERN, ProfileError } from "./types";

const scenario = new URLSearchParams(location.search).get("demo");
const latency = scenario === "slow" ? 2500 : 450;

// ------------------------------------------------------------------- people

interface PersonRecord {
  id: string;
  name: string;
  handle: string;
  bio: string;
  avatarUrl: string | null;
  joinedAt: Date;
}

const days = (n: number) => new Date(Date.now() - n * 86_400_000);
const minutes = (n: number) => new Date(Date.now() - n * 60_000);

const peopleList: PersonRecord[] = [
  { id: "me", name: "Sam Okafor", handle: "samokafor", bio: "Making things on the internet. Lagos ↔ London.", avatarUrl: null, joinedAt: days(420) },
  { id: "ama", name: "Ama Mensah", handle: "amamensah", bio: "Photographer. Rooftops, markets, people.", avatarUrl: "https://i.pravatar.cc/160?img=47", joinedAt: days(390) },
  { id: "leo", name: "Leo Park", handle: "leopark", bio: "Weekend hiker, weekday group-chat admin.", avatarUrl: "https://i.pravatar.cc/160?img=12", joinedAt: days(300) },
  { id: "rosa", name: "Rosa Delgado", handle: "rosadelgado", bio: "Running my first half marathons and writing about it.", avatarUrl: null, joinedAt: days(200) },
  { id: "kofi", name: "Kofi Boateng", handle: "kofiboateng", bio: "Food, football and opinions about both.", avatarUrl: "https://i.pravatar.cc/160?img=59", joinedAt: days(150) },
  { id: "mira", name: "Mira Iyer", handle: "miraiyer", bio: "Producer. New track every Friday-ish.", avatarUrl: "https://i.pravatar.cc/160?img=32", joinedAt: days(120) },
  { id: "jun", name: "Jun Watanabe", handle: "junwatanabe", bio: "", avatarUrl: null, joinedAt: days(60) },
  { id: "zoe", name: "Zoë Laurent", handle: "zoelaurent", bio: "Paris. Coffee, rain, film photos.", avatarUrl: "https://i.pravatar.cc/160?img=45", joinedAt: days(40) },
  { id: "tomi", name: "Tomi Adeyemi", handle: "tomiadeyemi", bio: "Reminding you to drink water since 2019.", avatarUrl: "https://i.pravatar.cc/160?img=68", joinedAt: days(30) },
];
const people = new Map(peopleList.map((p) => [p.id, p]));

const follows = new Set<string>([
  "me->ama", "me->leo",
  "ama->me", "leo->me", "zoe->me", "kofi->me",
  "ama->leo", "ama->mira", "leo->ama", "tomi->ama", "zoe->ama", "rosa->ama",
  "mira->zoe", "jun->tomi", "kofi->ama", "tomi->mira",
]);
const edge = (a: string, b: string) => `${a}->${b}`;

// -------------------------------------------------------------------- posts

interface PostRecord {
  id: string;
  authorId: string;
  text: string;
  media: MediaItem[];
  createdAt: Date;
  /** Likes from people outside the demo cast, to make counts realistic. */
  baseLikes: number;
  likers: Set<string>;
  parentId: string | null;
}

const img = (seed: string, w: number, h: number): MediaItem => ({ type: "image", url: `https://picsum.photos/seed/${seed}/${w}/${h}`, width: w, height: h });
const rec = (id: string, authorId: string, text: string, createdAt: Date, baseLikes: number, media: MediaItem[] = [], parentId: string | null = null, likers: string[] = []): PostRecord =>
  ({ id, authorId, text, media, createdAt, baseLikes, likers: new Set(likers), parentId });

let records: PostRecord[] = [
  rec("p1", "ama", "Golden hour on the rooftop again. Some days the city just gets it right.", minutes(4), 128, [img("amigo-roof", 1200, 1500)]),
  rec("p2", "leo", "Hot take: the best group chats are the ones where nobody ever says what the plan actually is 😂", minutes(19), 341, [], null, ["me"]),
  rec("p3", "rosa", "Finished my first half marathon this morning. 2:04:31. Legs are gone, heart is full. Thank you to everyone who sent messages this week — I read every single one.", minutes(47), 891),
  rec("p4", "kofi", "", minutes(83), 76, [img("amigo-market", 1600, 1067)]),
  rec("p5", "mira", "Studio day. New track drops Friday. Here's a tiny peek at the setup 🎧", minutes(140), 1204, [img("amigo-studio", 1080, 1080)]),
  rec("p6", "jun", "Anyone else keep a running list of small things that made the day better? Today: perfect toast, a stranger's dog, and finding my old headphones.", minutes(260), 57),
  rec("p7", "zoe", "Paris in the rain hits different", minutes(390), 2309, [img("amigo-paris", 1000, 1400)], null, ["me"]),
  rec("p8", "tomi", "Reminder that you're allowed to log off for a while. The timeline will still be here. Go drink some water.", minutes(60 * 9), 4120),
  rec("me1", "me", "Finally moved the plants to the window. They look happier already.", minutes(60 * 15), 23, [img("amigo-window", 1200, 900)]),
  rec("p9", "leo", "Weekend hike crew, same time next month?", minutes(60 * 22), 64, [img("amigo-trail", 1600, 900)]),
  rec("p10", "ama", "Market day colours.", minutes(60 * 30), 210, [img("amigo-colours", 1080, 1350)]),
  rec("me2", "me", "What's one app you'd delete if you could only keep five?", minutes(60 * 40), 12),
  rec("p11", "kofi", "Jollof debate is closed. We won. Moving on.", minutes(60 * 49), 980),
  rec("p12", "mira", "Sunday reset.", minutes(60 * 75), 233, [img("amigo-plant", 1080, 1350)]),
  rec("p13", "ama", "Shot this one on the walk home. No edits.", minutes(60 * 100), 340, [img("amigo-street", 1600, 1067)]),
  // replies
  rec("r1", "tomi", "the plan is vibes. always has been.", minutes(15), 9, [], "p2"),
  rec("r2", "zoe", "Felt this in my soul", minutes(12), 4, [], "p2"),
  rec("r3", "jun", "We had a 400 message chat about brunch and never went to brunch", minutes(6), 21, [], "p2"),
  rec("r4", "ama", "SO proud of you!! 🎉", minutes(40), 6, [], "p3"),
  rec("r5", "me", "This is the most relatable thing I've read all week", minutes(10), 3, [], "p2"),
  rec("r6", "me", "Congrats Rosa! Huge.", minutes(30), 2, [], "p3"),
  rec("r7", "leo", "Rooftop crew when?", minutes(2), 1, [], "p1"),
];

// ------------------------------------------------------------------ helpers

type Listener = () => void;
const listeners = new Set<Listener>();
const emit = () => listeners.forEach((l) => l());
const later = <T>(fn: () => T, ms = latency) => new Promise<T>((r) => setTimeout(() => r(fn()), ms));

function watch<T>(sub: Subscription<T>, read: () => T): () => void {
  if (scenario === "loading") return () => {};
  let active = true;
  const timer = setTimeout(() => {
    if (!active) return;
    if (scenario === "error") return sub.onError(new Error("Demo network error"));
    sub.onData(read());
  }, latency);
  const l = () => active && scenario !== "error" && sub.onData(read());
  listeners.add(l);
  return () => {
    active = false;
    clearTimeout(timer);
    listeners.delete(l);
  };
}

const author = (id: string): Author => {
  const p = people.get(id)!;
  return { id: p.id, name: p.name, handle: p.handle, avatarUrl: p.avatarUrl };
};

const replyCount = (id: string) => records.filter((r) => r.parentId === id).length;

function toPost(r: PostRecord): Post {
  const parent = r.parentId ? records.find((x) => x.id === r.parentId) : null;
  return {
    id: r.id,
    author: author(r.authorId),
    text: r.text,
    media: r.media,
    createdAt: r.createdAt,
    likeCount: r.baseLikes + r.likers.size,
    likedByViewer: r.likers.has("me"),
    replyCount: replyCount(r.id),
    replyTo: parent ? { postId: parent.id, handle: people.get(parent.authorId)!.handle } : null,
  };
}

const newest = (a: PostRecord, b: PostRecord) => b.createdAt.getTime() - a.createdAt.getTime();
const topLevel = () => (scenario === "empty" ? [] : records.filter((r) => !r.parentId).sort(newest));

function profileOf(p: PersonRecord, viewerId: string): Profile {
  return {
    id: p.id,
    name: p.name,
    handle: p.handle,
    bio: p.bio,
    avatarUrl: p.avatarUrl,
    followerCount: [...follows].filter((e) => e.endsWith(`->${p.id}`)).length,
    followingCount: [...follows].filter((e) => e.startsWith(`${p.id}->`)).length,
    postCount: records.filter((r) => r.authorId === p.id && !r.parentId).length,
    joinedAt: p.joinedAt,
    viewerFollows: follows.has(edge(viewerId, p.id)),
    isViewer: p.id === viewerId,
  };
}

const summary = (p: PersonRecord, viewerId: string): PersonSummary => ({
  id: p.id, name: p.name, handle: p.handle, avatarUrl: p.avatarUrl, viewerFollows: follows.has(edge(viewerId, p.id)),
});

// -------------------------------------------------------------------- auth

const viewerFromPerson = (p: PersonRecord): Viewer => ({ id: p.id, name: p.name, handle: p.handle, email: "sam@example.com", avatarUrl: p.avatarUrl });
let signedIn = scenario !== "signedout";
const viewerListeners = new Set<(v: Viewer | null) => void>();
const emitViewer = () => viewerListeners.forEach((l) => l(signedIn ? viewerFromPerson(people.get("me")!) : null));

// ------------------------------------------------------------------- source

export const demoSource: DataSource = {
  kind: "demo",

  onViewerChanged(cb) {
    viewerListeners.add(cb);
    setTimeout(() => cb(signedIn ? viewerFromPerson(people.get("me")!) : null), 150);
    return () => viewerListeners.delete(cb);
  },
  signIn: () => later(() => { signedIn = true; emitViewer(); }),
  signUp: (_e, _p, name) =>
    later(() => {
      people.get("me")!.name = name;
      signedIn = true;
      emitViewer();
      return { needsEmailConfirmation: false };
    }),
  sendPasswordReset: () => later(() => undefined),
  updatePassword: () => later(() => undefined),
  signOut: () => later(() => { signedIn = false; emitViewer(); }, 100),
  updateDisplayName: (name) => later(() => { people.get("me")!.name = name; emitViewer(); emit(); }),

  subscribeLatestPosts(_viewerId, limit, sub) {
    return watch(sub, () => {
      const list = topLevel();
      return { posts: list.slice(0, limit).map(toPost), hasMore: list.length > limit };
    });
  },

  subscribePost(postId, _viewerId, sub) {
    return watch(sub, () => {
      const r = records.find((x) => x.id === postId);
      return r ? toPost(r) : null;
    });
  },

  createPost: (v, input) =>
    later(() => {
      records = [
        rec(`p${Date.now()}`, v.id, input.text.trim(), new Date(), 0,
          input.image ? [{ type: "image", url: input.image.dataUrl, width: input.image.width, height: input.image.height }] : []),
        ...records,
      ];
      emit();
    }, 700),

  setLiked: (postId, viewerId, liked) =>
    later(() => {
      const r = records.find((x) => x.id === postId);
      if (r) liked ? r.likers.add(viewerId) : r.likers.delete(viewerId);
      emit();
    }, 250),

  subscribeReplies(postId, sub) {
    return watch(sub, (): Reply[] =>
      records
        .filter((r) => r.parentId === postId)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .map((r) => ({ id: r.id, postId, author: author(r.authorId), text: r.text, createdAt: r.createdAt })),
    );
  },

  addReply: (postId, v, text) =>
    later(() => {
      records = [...records, rec(`r${Date.now()}`, v.id, text, new Date(), 0, [], postId)];
      emit();
    }),

  getFollowingIds: (viewerId) => later(() => new Set([...follows].filter((e) => e.startsWith(`${viewerId}->`)).map((e) => e.split("->")[1]))),
  getPeopleSuggestions: (viewerId, max) =>
    later(() => peopleList.filter((p) => p.id !== viewerId && !follows.has(edge(viewerId, p.id))).slice(0, max).map((p) => summary(p, viewerId))),
  follow: (viewerId, id) => later(() => { follows.add(edge(viewerId, id)); emit(); }, 300),
  unfollow: (viewerId, id) => later(() => { follows.delete(edge(viewerId, id)); emit(); }, 300),

  profiles: {
    getProfile: (handle, viewerId) =>
      later(() => {
        if (scenario === "error") throw new Error("Demo network error");
        const p = peopleList.find((x) => x.handle === handle.toLowerCase());
        return p ? profileOf(p, viewerId) : null;
      }),

    subscribeProfilePosts(profileId, _viewerId, tab: ProfileTab, limit, sub) {
      return watch(sub, () => {
        const mine = records.filter((r) => r.authorId === profileId).sort(newest);
        const list =
          tab === "posts" ? mine.filter((r) => !r.parentId) : tab === "replies" ? mine.filter((r) => r.parentId) : mine.filter((r) => r.media.length > 0);
        return { posts: list.slice(0, limit).map(toPost), hasMore: list.length > limit };
      });
    },

    listFollows: (profileId, kind, viewerId) =>
      later(() =>
        [...follows]
          .map((e) => e.split("->"))
          .filter(([a, b]) => (kind === "followers" ? b === profileId : a === profileId))
          .map(([a, b]) => people.get(kind === "followers" ? a : b)!)
          .map((p) => summary(p, viewerId)),
      ),

    isHandleAvailable: (handle, viewerId) =>
      later(() => !peopleList.some((p) => p.handle === handle.toLowerCase() && p.id !== viewerId), 200),

    updateProfile: (viewerId, u: ProfileUpdate) =>
      later(() => {
        const p = people.get(viewerId)!;
        if (u.handle !== undefined) {
          const h = u.handle.toLowerCase();
          if (!HANDLE_PATTERN.test(h)) throw new ProfileError("handle-invalid");
          if (peopleList.some((x) => x.handle === h && x.id !== viewerId)) throw new ProfileError("handle-taken");
          p.handle = h;
        }
        if (u.name !== undefined) p.name = u.name.trim();
        if (u.bio !== undefined) p.bio = u.bio.trim();
        if (u.avatar !== undefined) p.avatarUrl = u.avatar ? u.avatar.dataUrl : null;
        emitViewer();
        emit();
      }, 600),
  },
};
