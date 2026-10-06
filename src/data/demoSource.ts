/**
 * In-memory data source for UI development (`npm run dev:demo`).
 * Never bundled into production builds' code path unless VITE_DATA_SOURCE=demo.
 *
 * Preview states with a query param: ?demo=loading | empty | error | slow | signedout
 */
import { toHandle } from "../lib/handle";
import type { Author, DataSource, PersonSummary, Post, Reply, Subscription, Viewer } from "./types";

const scenario = new URLSearchParams(location.search).get("demo");
const latency = scenario === "slow" ? 2500 : 450;

const me: Viewer = { id: "me", name: "Sam Okafor", handle: "samokafor", email: "sam@example.com", avatarUrl: null };

function person(id: string, name: string, avatar?: string): Author {
  return { id, name, handle: toHandle(name.replace(/\s+/g, "")), avatarUrl: avatar ?? null };
}

const people = {
  ama: person("ama", "Ama Mensah", "https://i.pravatar.cc/160?img=47"),
  leo: person("leo", "Leo Park", "https://i.pravatar.cc/160?img=12"),
  rosa: person("rosa", "Rosa Delgado"),
  kofi: person("kofi", "Kofi Boateng", "https://i.pravatar.cc/160?img=59"),
  mira: person("mira", "Mira Iyer", "https://i.pravatar.cc/160?img=32"),
  jun: person("jun", "Jun Watanabe"),
  zoe: person("zoe", "Zoë Laurent", "https://i.pravatar.cc/160?img=45"),
  tomi: person("tomi", "Tomi Adeyemi", "https://i.pravatar.cc/160?img=68"),
};

const minutes = (n: number) => new Date(Date.now() - n * 60_000);
const img = (seed: string, w: number, h: number) => ({
  type: "image" as const,
  url: `https://picsum.photos/seed/${seed}/${w}/${h}`,
  width: w,
  height: h,
});

let posts: Post[] = [
  { id: "p1", author: people.ama, text: "Golden hour on the rooftop again. Some days the city just gets it right.", media: [img("amigo-roof", 1200, 1500)], createdAt: minutes(4), likeCount: 128, likedByViewer: false, replyCount: 14 },
  { id: "p2", author: people.leo, text: "Hot take: the best group chats are the ones where nobody ever says what the plan actually is 😂", media: [], createdAt: minutes(19), likeCount: 342, likedByViewer: true, replyCount: 58 },
  { id: "p3", author: people.rosa, text: "Finished my first half marathon this morning. 2:04:31. Legs are gone, heart is full. Thank you to everyone who sent messages this week — I read every single one.", media: [], createdAt: minutes(47), likeCount: 891, likedByViewer: false, replyCount: 102 },
  { id: "p4", author: people.kofi, text: "", media: [img("amigo-market", 1600, 1067)], createdAt: minutes(83), likeCount: 76, likedByViewer: false, replyCount: 3 },
  { id: "p5", author: people.mira, text: "Studio day. New track drops Friday. Here's a tiny peek at the setup 🎧", media: [img("amigo-studio", 1080, 1080)], createdAt: minutes(140), likeCount: 1204, likedByViewer: false, replyCount: 87 },
  { id: "p6", author: people.jun, text: "Anyone else keep a running list of small things that made the day better? Today: perfect toast, a stranger's dog, and finding my old headphones.", media: [], createdAt: minutes(260), likeCount: 57, likedByViewer: false, replyCount: 9 },
  { id: "p7", author: people.zoe, text: "Paris in the rain hits different", media: [img("amigo-paris", 1000, 1400)], createdAt: minutes(390), likeCount: 2310, likedByViewer: true, replyCount: 141 },
  { id: "p8", author: people.tomi, text: "Reminder that you're allowed to log off for a while. The timeline will still be here. Go drink some water.", media: [], createdAt: minutes(60 * 9), likeCount: 4120, likedByViewer: false, replyCount: 233 },
  { id: "p9", author: people.leo, text: "Weekend hike crew, same time next month?", media: [img("amigo-trail", 1600, 900)], createdAt: minutes(60 * 22), likeCount: 64, likedByViewer: false, replyCount: 11 },
  { id: "p10", author: people.ama, text: "https://amigo.world is looking very different these days 👀", media: [], createdAt: minutes(60 * 30), likeCount: 19, likedByViewer: false, replyCount: 2 },
  { id: "p11", author: people.kofi, text: "Jollof debate is closed. We won. Moving on.", media: [], createdAt: minutes(60 * 49), likeCount: 980, likedByViewer: false, replyCount: 410 },
  { id: "p12", author: people.mira, text: "Sunday reset.", media: [img("amigo-plant", 1080, 1350)], createdAt: minutes(60 * 75), likeCount: 233, likedByViewer: false, replyCount: 12 },
];

const replies: Record<string, Reply[]> = {
  p2: [
    { id: "r1", postId: "p2", author: people.tomi, text: "the plan is vibes. always has been.", createdAt: minutes(15) },
    { id: "r2", postId: "p2", author: people.zoe, text: "Felt this in my soul", createdAt: minutes(12) },
    { id: "r3", postId: "p2", author: people.jun, text: "We had a 400 message chat about brunch and never went to brunch", createdAt: minutes(6) },
  ],
  p3: [{ id: "r4", postId: "p3", author: people.ama, text: "SO proud of you!! 🎉", createdAt: minutes(40) }],
};

const suggestions: PersonSummary[] = [people.mira, people.zoe, people.tomi, people.jun].map((p) => ({ ...p, viewerFollows: false }));
const following = new Set<string>(["ama", "leo"]);

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

let viewer: Viewer | null = scenario === "signedout" ? null : me;
const viewerListeners = new Set<(v: Viewer | null) => void>();
const setViewer = (v: Viewer | null) => {
  viewer = v;
  viewerListeners.forEach((l) => l(v));
};

export const demoSource: DataSource = {
  kind: "demo",

  onViewerChanged(cb) {
    viewerListeners.add(cb);
    setTimeout(() => cb(viewer), 150);
    return () => viewerListeners.delete(cb);
  },
  signIn: () => later(() => setViewer(me)),
  signUp: (_e, _p, name) => later(() => setViewer({ ...me, name, handle: toHandle(name) })),
  sendPasswordReset: () => later(() => undefined),
  signOut: () => later(() => setViewer(null), 100),
  updateDisplayName: (name) => later(() => void (viewer && setViewer({ ...viewer, name, handle: toHandle(name) }))),

  subscribeLatestPosts(_viewerId, limit, sub) {
    return watch(sub, () => {
      const list = scenario === "empty" ? [] : posts;
      return { posts: list.slice(0, limit), hasMore: list.length > limit };
    });
  },

  subscribePost(postId, _viewerId, sub) {
    return watch(sub, () => posts.find((p) => p.id === postId) ?? null);
  },

  createPost: (v, input) =>
    later(() => {
      posts = [
        {
          id: `p${Date.now()}`,
          author: { id: v.id, name: v.name, handle: v.handle, avatarUrl: v.avatarUrl },
          text: input.text.trim(),
          media: input.image ? [{ type: "image", url: input.image.dataUrl, width: input.image.width, height: input.image.height }] : [],
          createdAt: new Date(),
          likeCount: 0,
          likedByViewer: false,
          replyCount: 0,
        },
        ...posts,
      ];
      emit();
    }, 700),

  setLiked: (postId, _viewerId, liked) =>
    later(() => {
      posts = posts.map((p) =>
        p.id === postId && p.likedByViewer !== liked
          ? { ...p, likedByViewer: liked, likeCount: p.likeCount + (liked ? 1 : -1) }
          : p,
      );
      emit();
    }, 250),

  subscribeReplies(postId, sub) {
    return watch(sub, () => replies[postId] ?? []);
  },

  addReply: (postId, v, text) =>
    later(() => {
      const author = { id: v.id, name: v.name, handle: v.handle, avatarUrl: v.avatarUrl };
      replies[postId] = [...(replies[postId] ?? []), { id: `r${Date.now()}`, postId, author, text, createdAt: new Date() }];
      posts = posts.map((p) => (p.id === postId ? { ...p, replyCount: p.replyCount + 1 } : p));
      emit();
    }),

  getFollowingIds: () => later(() => new Set(following)),
  getPeopleSuggestions: (_v, max) => later(() => suggestions.filter((s) => !following.has(s.id)).slice(0, max)),
  follow: (_v, id) => later(() => void following.add(id), 300),
  unfollow: (_v, id) => later(() => void following.delete(id), 300),
};
