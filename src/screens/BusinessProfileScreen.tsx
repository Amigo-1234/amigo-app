import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { ArrowLeft, CircleAlert, Feather, Flag, Globe, Image as ImageIcon, Link2, Mail, MoreHorizontal, Phone, Settings, Store, X } from "lucide-react";
import { dataSource, POST_MAX_LENGTH, type Business, type NewMediaInput, type Post } from "../data";
import { BusinessFollowButton } from "./BusinessScreen";
import { businessApi, onBusinessPostsChanged, useMyBusiness } from "../features/business/useMyBusiness";
import { BusinessLogo, businessErrorText, categoryLabel } from "../features/business/shared";
import { describeError } from "../features/feed/errors";
import { PostCard } from "../features/posts/PostCard";
import { FeedSkeleton } from "../features/posts/PostSkeleton";
import { ReportForm } from "../features/posts/PostOptions";
import { RichText } from "../features/posts/RichText";
import { formatCount } from "../lib/format";
import { processImage } from "../lib/image";
import { publicUrl } from "../lib/publicUrl";
import { MediaImg } from "../lib/mediaLinks";
import { ScreenHeader } from "../shell/ScreenHeader";
import { useToast } from "../state/toast";
import { Button, IconButton } from "../ui/Button";
import { Sheet } from "../ui/Sheet";
import { StateMessage } from "../ui/StateMessage";

const PAGE = 30;

/** /b/:handle — a business page. Who runs it is never shown. */
export default function BusinessProfileScreen() {
  const { handle = "" } = useParams();
  const navigate = useNavigate();
  const [business, setBusiness] = useState<Business | null | undefined>(undefined);
  const [failed, setFailed] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  const back = () => (window.history.state?.idx > 0 ? navigate(-1) : navigate("/business"));

  useEffect(() => {
    let live = true;
    setBusiness(undefined);
    setFailed(null);
    businessApi!.byHandle(handle).then(
      (b) => live && setBusiness(b),
      (e) => live && setFailed(e ?? new Error("failed")),
    );
    return () => {
      live = false;
    };
  }, [handle, attempt]);

  return (
    <>
      <ScreenHeader
        title={business ? business.name : `/b/${handle}`}
        leading={
          <IconButton label="Back" onClick={back} className="back-btn">
            <ArrowLeft size={22} />
          </IconButton>
        }
        actions={
          business?.mine ? (
            <Link to="/settings/business" className="icon-btn icon-btn--md" aria-label="Business settings" title="Business settings">
              <Settings size={21} aria-hidden="true" />
            </Link>
          ) : undefined
        }
      />
      {failed ? (
        <StateMessage tone="error" icon={<CircleAlert size={24} />} {...describeError(failed, "this page")} action={<Button variant="secondary" onClick={() => setAttempt((n) => n + 1)}>Try again</Button>} />
      ) : business === undefined ? (
        <FeedSkeleton />
      ) : business === null ? (
        <StateMessage
          icon={<Store size={24} />}
          title="This business page isn't available"
          body={`There's no business at /b/${handle}. Check the spelling, or the page may have been removed.`}
          action={<Button variant="secondary" onClick={() => navigate("/business")}>Find businesses</Button>}
        />
      ) : (
        <BusinessPage business={business} onChange={setBusiness} />
      )}
    </>
  );
}

function BusinessPage({ business, onChange }: { business: Business; onChange: (b: Business) => void }) {
  const [posts, setPosts] = useState<Post[] | null>(null);
  const [postsError, setPostsError] = useState<unknown>(null);
  const loadPosts = useCallback(() => {
    setPostsError(null);
    businessApi!.posts(business.id, PAGE).then(setPosts, (e) => setPostsError(e ?? new Error("failed")));
  }, [business.id]);
  useEffect(loadPosts, [loadPosts]);
  // A post deleted from its menu leaves the list.
  useEffect(() => onBusinessPostsChanged(loadPosts), [loadPosts]);

  return (
    <>
      <div className="biz-cover">{business.coverUrl && <MediaImg src={business.coverUrl} alt="" decoding="async" />}</div>
      <section className="biz-profile" aria-label={`${business.name}, business page`}>
        <div className="biz-profile__top">
          <BusinessLogo name={business.name} src={business.logoUrl} size="xl" />
          <div className="biz-profile__action">
            {!business.mine && (
              <BusinessFollowButton id={business.id} name={business.name} following={business.following} onChange={(following, followerCount) => onChange({ ...business, following, followerCount })} />
            )}
            <BusinessOptions business={business} />
          </div>
        </div>
        <h2 className="biz-profile__name">{business.name}</h2>
        <p className="biz-profile__handle">
          <span className="post__business">Business</span> /b/{business.handle} · {categoryLabel(business.category)}
        </p>
        {business.description && (
          <p className="biz-profile__desc">
            <RichText text={business.description} />
          </p>
        )}
        {(business.website || business.email || business.phone) && (
          <ul className="biz-profile__contacts">
            {business.website && (
              <li>
                <a href={business.website} target="_blank" rel="noopener noreferrer nofollow ugc">
                  <Globe size={15} aria-hidden="true" />
                  {business.website.replace(/^https:\/\//, "").replace(/\/$/, "")}
                </a>
              </li>
            )}
            {business.email && (
              <li>
                <a href={`mailto:${business.email}`}>
                  <Mail size={15} aria-hidden="true" />
                  {business.email}
                </a>
              </li>
            )}
            {business.phone && (
              <li>
                <a href={`tel:${business.phone.replace(/[^\d+]/g, "")}`}>
                  <Phone size={15} aria-hidden="true" />
                  {business.phone}
                </a>
              </li>
            )}
          </ul>
        )}
        <p className="biz-profile__stats">
          <span>
            <strong>{formatCount(business.followerCount)}</strong> {business.followerCount === 1 ? "follower" : "followers"}
          </span>
          <span>
            <strong>{formatCount(business.postCount)}</strong> {business.postCount === 1 ? "post" : "posts"}
          </span>
        </p>
      </section>

      {business.mine && (
        <BusinessComposer
          onPosted={() => {
            onChange({ ...business, postCount: business.postCount + 1 });
            loadPosts();
          }}
        />
      )}

      <section className="biz-posts" aria-label="Posts" aria-busy={!posts && !postsError}>
        {postsError ? (
          <StateMessage tone="error" icon={<CircleAlert size={24} />} {...describeError(postsError)} action={<Button variant="secondary" onClick={loadPosts}>Try again</Button>} />
        ) : !posts ? (
          <FeedSkeleton />
        ) : posts.length === 0 ? (
          <StateMessage icon={<Feather size={24} />} title={business.mine ? "Your business hasn't posted yet" : `${business.name} hasn't posted yet`} body={business.mine ? "Post an update above. Followers see it in their Following feed." : "When they do, posts will show up here."} />
        ) : (
          posts.map((p) => <PostCard key={p.id} post={p} />)
        )}
      </section>
    </>
  );
}

/** Copy link, and report the business (not for your own). */
function BusinessOptions({ business }: { business: Business }) {
  const toast = useToast();
  const [sheet, setSheet] = useState<null | "menu" | "report">(null);
  const close = () => setSheet(null);
  return (
    <>
      <IconButton label={`More options for ${business.name}`} onClick={() => setSheet("menu")}>
        <MoreHorizontal size={20} />
      </IconButton>
      <Sheet open={sheet === "menu"} onClose={close} label="Business options">
        <div className="sheet-menu">
          <button
            className="sheet-menu__item"
            onClick={async () => {
              close();
              try {
                await navigator.clipboard.writeText(publicUrl(`/b/${business.handle}`));
                toast("Link copied");
              } catch {
                toast("Couldn't copy the link", "error");
              }
            }}
          >
            <Link2 size={20} aria-hidden="true" /> Copy page link
          </button>
          {dataSource.postTools && !business.mine && (
            <button className="sheet-menu__item sheet-menu__item--danger" onClick={() => setSheet("report")}>
              <Flag size={20} aria-hidden="true" /> Report business
            </button>
          )}
          <Button variant="ghost" block onClick={close}>
            Cancel
          </Button>
        </div>
      </Sheet>
      <Sheet open={sheet === "report"} onClose={close} label="Report">
        {sheet === "report" && <ReportForm target="business" targetId={business.id} what="business" onDone={close} />}
      </Sheet>
    </>
  );
}

/** Owner only: a public post as the business. Text and up to 4 photos; it can be deleted, not edited. */
function BusinessComposer({ onPosted }: { onPosted: () => void }) {
  const toast = useToast();
  const { state } = useMyBusiness();
  const [text, setText] = useState("");
  const [images, setImages] = useState<(NewMediaInput & { url: string })[]>([]);
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const urls = useRef(new Set<string>());
  const suspended = state?.business?.status === "suspended";
  const trimmed = text.trim();
  const canPost = !busy && !picking && !suspended && trimmed.length <= POST_MAX_LENGTH && (trimmed.length > 0 || images.length > 0);

  useEffect(() => () => urls.current.forEach((u) => URL.revokeObjectURL(u)), []);

  if (suspended) return <p className="form-error biz-notice">This business is suspended, so it can't post. Contact Amigo support.</p>;

  return (
    <form
      className="biz-compose"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!canPost) return;
        setBusy(true);
        try {
          await businessApi!.createPost(trimmed, images.map(({ url: _url, ...m }) => m));
          setText("");
          setImages([]);
          toast("Posted as your business");
          onPosted();
        } catch (err) {
          toast(businessErrorText(err), "error");
        } finally {
          setBusy(false);
        }
      }}
    >
      <label className="field">
        <span className="field__label">Post as your business</span>
        <textarea className="field__input" rows={3} maxLength={POST_MAX_LENGTH} value={text} onChange={(e) => setText(e.target.value)} placeholder="Share an update, offer or event" />
      </label>
      {images.length > 0 && (
        <div className="biz-compose__thumbs">
          {images.map((m, i) => (
            <span key={m.url} style={{ position: "relative" }}>
              <img src={m.url} alt="" />
              <IconButton label="Remove photo" size="sm" onClick={() => setImages((list) => list.filter((_, j) => j !== i))} style={{ position: "absolute", top: -6, right: -6 }}>
                <X size={14} />
              </IconButton>
            </span>
          ))}
        </div>
      )}
      <div className="biz-compose__bar">
        <Button type="button" variant="ghost" size="sm" icon={<ImageIcon size={18} aria-hidden="true" />} disabled={images.length >= 4} loading={picking} onClick={() => fileRef.current?.click()}>
          Photo
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={async (e) => {
            const files = Array.from(e.target.files ?? []).slice(0, 4 - images.length);
            e.target.value = "";
            if (!files.length) return;
            setPicking(true);
            try {
              const done = await Promise.all(files.map(processImage));
              setImages((list) => [...list, ...done.map((d) => {
                  const url = URL.createObjectURL(d.blob);
                  urls.current.add(url);
                  return { kind: "image" as const, blob: d.blob, width: d.width, height: d.height, url };
                })].slice(0, 4));
            } catch (err) {
              toast(err instanceof Error ? err.message : "Couldn't use that photo", "error");
            } finally {
              setPicking(false);
            }
          }}
        />
        <Button type="submit" size="sm" loading={busy} disabled={!canPost}>
          Post
        </Button>
      </div>
    </form>
  );
}
