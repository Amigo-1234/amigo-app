/**
 * Business profiles in demo mode: in memory, for UI work and browser tests. Off unless the page
 * is opened with ?demo=business (as on a real backend, where an admin turns them on).
 */
import { BusinessError, type AdminBusiness, type Business, type BusinessApi, type BusinessInput, type MyBusiness, type Post, type Viewer } from "./types";

type Rec = Omit<Business, "following" | "mine" | "postCount"> & { ownerId: string; status: "active" | "suspended"; handleChangedAt: Date };

const HANDLE = /^[a-z0-9_]{3,24}$/;
const RESERVED = new Set(["amigo", "amigoworld", "admin", "support", "official", "help", "team", "security", "staff", "moderator"]);

export function createDemoBusiness(deps: { enabled: boolean; viewer: () => Viewer; later: <T>(fn: () => T, ms?: number) => Promise<T> }): BusinessApi {
  let enabled = deps.enabled;
  const days = (n: number) => new Date(Date.now() - n * 86_400_000);
  const recs: Rec[] = [
    { id: "biz-kitchen", ownerId: "kofi", handle: "kofis_kitchen", name: "Kofi's Kitchen", category: "food_drink", description: "Jollof, suya and weekend specials. Delivery across the island.", logoUrl: null, coverUrl: null, website: "https://kofis-kitchen.example.com", email: null, phone: "+234 801 000 0000", followerCount: 128, createdAt: days(40), status: "active", handleChangedAt: days(40) },
    { id: "biz-studio", ownerId: "mira", handle: "mira_studio", name: "Mira Studio", category: "creative_media", description: "Portraits, events and product photography.", logoUrl: null, coverUrl: null, website: null, email: "hello@mirastudio.example.com", phone: null, followerCount: 54, createdAt: days(12), status: "active", handleChangedAt: days(12) },
    { id: "biz-tech", ownerId: "leo", handle: "leo_repairs", name: "Leo Phone Repairs", category: "technology", description: "Screens, batteries and same-day fixes.", logoUrl: null, coverUrl: null, website: null, email: null, phone: null, followerCount: 9, createdAt: days(3), status: "active", handleChangedAt: days(3) },
  ];
  const posts: { id: string; businessId: string; text: string; createdAt: Date }[] = [
    { id: "bp-1", businessId: "biz-kitchen", text: "Weekend special: smoky party jollof with grilled chicken. Order by Friday!", createdAt: days(1) },
    { id: "bp-2", businessId: "biz-studio", text: "A few spots left for October portrait sessions.", createdAt: days(2) },
  ];
  const follows = new Set<string>(["biz-kitchen"]);
  const me = () => deps.viewer().id;
  const mine = () => recs.find((r) => r.ownerId === me()) ?? null;
  const live = (r: Rec) => r.status === "active";
  const view = (r: Rec): Business => ({
    ...r,
    following: follows.has(r.id),
    mine: r.ownerId === me(),
    postCount: posts.filter((p) => p.businessId === r.id).length,
  });
  const check = (input: BusinessInput, handle: string) => {
    if (!HANDLE.test(handle) || RESERVED.has(handle)) throw new BusinessError("handle", "that handle isn't available");
    if (!input.name.trim() || input.name.trim().length > 50 || /amigo/i.test(input.name)) throw new BusinessError("name", "that name isn't allowed");
    if (input.website && !/^https:\/\/[a-z0-9.-]+\.[a-z]{2,}(\/\S*)?$/i.test(input.website)) throw new BusinessError("invalid", "check the details");
    if (recs.some((r) => r.handle === handle && r.ownerId !== me())) throw new BusinessError("handle", "that handle isn't available");
  };
  const toPostView = (p: (typeof posts)[number]): Post => {
    const b = recs.find((r) => r.id === p.businessId)!;
    return {
      id: p.id,
      author: { id: b.id, name: b.name, handle: b.handle, avatarUrl: b.logoUrl, business: true },
      text: p.text,
      media: [],
      createdAt: p.createdAt,
      likeCount: 0,
      likedByViewer: false,
      replyCount: 0,
    };
  };

  return {
    mine: () =>
      deps.later(() => {
        const r = mine();
        const business: MyBusiness | null = r
          ? { ...view(r), status: r.status, canChangeHandleAt: new Date(r.handleChangedAt.getTime() + 30 * 86_400_000) }
          : null;
        return { enabled, business };
      }, 150),
    create: (input) =>
      deps.later(() => {
        if (!enabled) throw new BusinessError("off");
        if (mine()) throw new BusinessError("already-have-one");
        const handle = input.handle.trim().toLowerCase();
        check(input, handle);
        const id = `biz-${handle}`;
        recs.push({
          id, ownerId: me(), handle, name: input.name.trim(), category: input.category, description: input.description.trim(),
          logoUrl: null, coverUrl: null, website: input.website || null, email: input.email.toLowerCase() || null, phone: input.phone || null,
          followerCount: 0, createdAt: new Date(), status: "active", handleChangedAt: new Date(),
        });
        return id;
      }),
    update: (input) =>
      deps.later(() => {
        const r = mine();
        if (!r) throw new BusinessError("unknown");
        if (!live(r)) throw new BusinessError("suspended");
        const handle = (input.handle || r.handle).trim().toLowerCase();
        check(input, handle);
        if (handle !== r.handle && Date.now() - r.handleChangedAt.getTime() < 30 * 86_400_000) throw new BusinessError("handle-too-soon");
        if (handle !== r.handle) r.handleChangedAt = new Date();
        Object.assign(r, { handle, name: input.name.trim(), category: input.category, description: input.description.trim(), website: input.website || null, email: input.email.toLowerCase() || null, phone: input.phone || null });
      }),
    remove: () =>
      deps.later(() => {
        const r = mine();
        if (!r) throw new BusinessError("unknown");
        if (!live(r)) throw new BusinessError("suspended");
        recs.splice(recs.indexOf(r), 1);
        for (let i = posts.length - 1; i >= 0; i--) if (posts[i].businessId === r.id) posts.splice(i, 1);
        follows.delete(r.id);
      }),
    setImage: (kind, image) =>
      deps.later(() => {
        const r = mine();
        if (!r) throw new BusinessError("unknown");
        const url = image ? URL.createObjectURL(image) : null;
        if (kind === "logo") r.logoUrl = url;
        else r.coverUrl = url;
      }),
    byHandle: (handle) =>
      deps.later(() => {
        const r = recs.find((x) => x.handle === handle.toLowerCase());
        return r && (live(r) || r.ownerId === me()) ? view(r) : null;
      }),
    posts: (businessId, limit) =>
      deps.later(() => posts.filter((p) => p.businessId === businessId).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, limit).map(toPostView)),
    search: (query, category) =>
      deps.later(() => {
        const q = query.trim().toLowerCase();
        return recs
          .filter((r) => live(r) && (!category || r.category === category) && (!q || r.name.toLowerCase().includes(q) || r.handle.includes(q)))
          .sort((a, b) => b.followerCount - a.followerCount)
          .map((r) => {
            const v = view(r);
            return { id: v.id, handle: v.handle, name: v.name, category: v.category, description: v.description.slice(0, 160), logoUrl: v.logoUrl, followerCount: v.followerCount, following: v.following };
          });
      }),
    follow: (businessId, follow) =>
      deps.later(() => {
        const r = recs.find((x) => x.id === businessId);
        if (!r || !live(r) || r.ownerId === me()) throw new BusinessError("unknown");
        if (follow && !follows.has(businessId)) {
          follows.add(businessId);
          r.followerCount += 1;
        } else if (!follow && follows.has(businessId)) {
          follows.delete(businessId);
          r.followerCount = Math.max(0, r.followerCount - 1);
        }
        return r.followerCount;
      }, 200),
    followedIds: () => deps.later(() => new Set(follows), 50),
    createPost: (text, images) =>
      deps.later(() => {
        const r = mine();
        if (!r) throw new BusinessError("unknown");
        if (!live(r)) throw new BusinessError("suspended");
        if (!text.trim() && images.length === 0) throw new BusinessError("invalid");
        const id = `bp-${posts.length + 1}-${Date.now()}`;
        posts.push({ id, businessId: r.id, text: text.trim(), createdAt: new Date() });
        return id;
      }),
    deletePost: (postId) =>
      deps.later(() => {
        const r = mine();
        const i = posts.findIndex((p) => p.id === postId && p.businessId === r?.id);
        if (i < 0) throw new BusinessError("unknown");
        posts.splice(i, 1);
      }),
    admin: {
      list: (status) =>
        deps.later(() =>
          recs
            .filter((r) => status === "all" || r.status === status)
            .map(
              (r): AdminBusiness => ({
                id: r.id, handle: r.handle, name: r.name, category: r.category, status: r.status, suspendedNote: null,
                followerCount: r.followerCount, postCount: posts.filter((p) => p.businessId === r.id).length, ownerHandle: r.ownerId, createdAt: r.createdAt,
              }),
            ),
        ),
      setStatus: (businessId, suspend) =>
        deps.later(() => {
          const r = recs.find((x) => x.id === businessId);
          if (r) r.status = suspend ? "suspended" : "active";
        }),
      setEnabled: (on) =>
        deps.later(() => {
          enabled = on;
        }),
    },
  };
}
