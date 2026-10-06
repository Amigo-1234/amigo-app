import { useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { ArrowLeft, CalendarDays, HandHeart, CircleAlert, Feather, Image as ImageIcon, Mail, MessageCircle, Settings, UserRoundX } from "lucide-react";
import { dataSource, type Profile, type ProfileTab, type SupportProfileStats } from "../data";
import { describeError } from "../features/feed/errors";
import { FeedFooter } from "../features/feed/FeedFooter";
import { PostCard } from "../features/posts/PostCard";
import { FeedSkeleton } from "../features/posts/PostSkeleton";
import { EditProfileSheet } from "../features/profile/EditProfileSheet";
import { FollowButton } from "../features/profile/FollowButton";
import { MediaGrid } from "../features/profile/MediaGrid";
import { useProfile, useProfilePosts } from "../features/profile/useProfile";
import { RichText } from "../features/posts/RichText";
import { formatCount } from "../lib/format";
import { ScreenHeader } from "../shell/ScreenHeader";
import { useComposer } from "../state/composer";
import { messagesEnabled } from "../state/messages";
import { useViewer } from "../state/session";
import { useToast } from "../state/toast";
import { Avatar } from "../ui/Avatar";
import { Button, IconButton } from "../ui/Button";
import { Skeleton } from "../ui/Skeleton";
import { StateMessage } from "../ui/StateMessage";
import "./ProfileScreen.css";
import "../features/support/Support.css";
import { VerifiedBadge } from "../ui/VerifiedBadge";

const TABS: { id: ProfileTab; label: string }[] = [
  { id: "posts", label: "Posts" },
  { id: "replies", label: "Replies" },
  { id: "media", label: "Media" },
];

const joined = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });

export default function ProfileScreen() {
  const { handle = "" } = useParams();
  const navigate = useNavigate();
  const { state, reload, patch } = useProfile(handle);
  const [editing, setEditing] = useState(false);

  const profile = state.status === "ready" ? state.data : null;
  const back = () => (window.history.state?.idx > 0 ? navigate(-1) : navigate("/"));

  return (
    <>
      <ScreenHeader
        title={profile ? `@${profile.handle}` : state.status === "loading" ? "Profile" : `@${handle}`}
        leading={
          profile?.isViewer ? undefined : (
            <IconButton label="Back" onClick={back} className="back-btn">
              <ArrowLeft size={22} />
            </IconButton>
          )
        }
        actions={
          profile?.isViewer ? (
            <Link to="/settings" className="icon-btn icon-btn--md" aria-label="Settings" title="Settings">
              <Settings size={21} aria-hidden="true" />
            </Link>
          ) : undefined
        }
      />

      {state.status === "loading" && <HeaderSkeleton />}

      {state.status === "error" && (
        <StateMessage
          tone="error"
          icon={<CircleAlert size={24} />}
          {...describeError(state.error)}
          action={<Button variant="secondary" onClick={reload}>Try again</Button>}
        />
      )}

      {state.status === "ready" && !profile && (
        <StateMessage
          icon={<UserRoundX size={24} />}
          title="This account doesn't exist"
          body={`There's nobody called @${handle} on Amigo. Check the spelling, or they may have changed their username.`}
          action={<Button variant="secondary" onClick={() => navigate("/")}>Back to Home</Button>}
        />
      )}

      {profile && (
        <>
          <ProfileHeader
            profile={profile}
            onEdit={() => setEditing(true)}
            onFollowChange={(following) =>
              patch((p) => ({ ...p, viewerFollows: following, followerCount: p.followerCount + (following ? 1 : -1) }))
            }
          />
          <ProfileTabs profile={profile} />
          {profile.isViewer && (
            <EditProfileSheet
              open={editing}
              profile={profile}
              onClose={() => setEditing(false)}
              onSaved={(handleChanged, newHandle) => {
                setEditing(false);
                if (handleChanged) navigate(`/u/${newHandle}`, { replace: true });
              }}
            />
          )}
        </>
      )}
    </>
  );
}

/** Opens (or starts) the one-to-one conversation with this person. */
function MessageButton({ profile }: { profile: Profile }) {
  const viewer = useViewer();
  const navigate = useNavigate();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant="secondary"
      size="md"
      loading={busy}
      icon={<Mail size={18} aria-hidden="true" />}
      aria-label={`Message ${profile.name}`}
      onClick={async () => {
        setBusy(true);
        try {
          const id = await dataSource.messages!.openConversation(viewer.id, profile.id);
          navigate(`/messages/${id}`);
        } catch {
          toast(`Couldn't open a conversation with ${profile.name}`, "error");
          setBusy(false);
        }
      }}
    >
      Message
    </Button>
  );
}

function ProfileHeader({ profile, onEdit, onFollowChange }: { profile: Profile; onEdit: () => void; onFollowChange: (f: boolean) => void }) {
  return (
    <section className="profile" aria-label={`${profile.name}'s profile`}>
      <div className="profile__top">
        <Avatar name={profile.name} src={profile.avatarUrl} seed={profile.id} size="xl" />
        <div className="profile__action">
          {profile.isViewer ? (
            <Button variant="secondary" size="sm" onClick={onEdit}>
              Edit profile
            </Button>
          ) : (
            <>
              {messagesEnabled && <MessageButton profile={profile} />}
              <FollowButton personId={profile.id} personName={profile.name} following={profile.viewerFollows} size="md" onChange={onFollowChange} />
            </>
          )}
        </div>
      </div>

      <h2 className="profile__name">
        {profile.name}
        <VerifiedBadge verified={profile.verified} size={20} />
      </h2>
      <p className="profile__handle">@{profile.handle}</p>

      {profile.bio && (
        <p className="profile__bio">
          <RichText text={profile.bio} />
        </p>
      )}

      {profile.joinedAt && (
        <p className="profile__meta">
          <CalendarDays size={15} aria-hidden="true" />
          Joined {joined.format(profile.joinedAt)}
        </p>
      )}

      <ul className="profile__stats">
        <li>
          <Link to={`/u/${profile.handle}/following`}>
            <strong>{formatCount(profile.followingCount)}</strong> following
          </Link>
        </li>
        <li>
          <Link to={`/u/${profile.handle}/followers`}>
            <strong>{formatCount(profile.followerCount)}</strong> {profile.followerCount === 1 ? "follower" : "followers"}
          </Link>
        </li>
        <li>
          <span>
            <strong>{formatCount(profile.postCount)}</strong> {profile.postCount === 1 ? "post" : "posts"}
          </span>
        </li>
      </ul>
      <SupportStat profile={profile} />
    </section>
  );
}

/** Restrained Support Hub line; hidden when there's nothing to show. */
function SupportStat({ profile }: { profile: Profile }) {
  const [stats, setStats] = useState<SupportProfileStats | null>(null);
  useEffect(() => {
    if (!dataSource.support) return;
    let cancelled = false;
    dataSource.support.profileStats(profile.id).then((s) => !cancelled && setStats(s)).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [profile.id]);
  if (!stats || (!stats.helpedCount && !stats.reputation && !stats.activeRequests)) return null;
  const parts = [
    <span key="h">Helped <strong>{stats.helpedCount}</strong> {stats.helpedCount === 1 ? "person" : "people"}</span>,
    <span key="r"><strong>{stats.reputation}</strong> Support reputation</span>,
  ];
  if (stats.activeRequests) parts.push(<span key="a"><strong>{stats.activeRequests}</strong> active {stats.activeRequests === 1 ? "request" : "requests"}</span>);
  return (
    <Link to={profile.isViewer ? "/support?section=mine" : "/support"} className="profile__support" aria-label={`Support Hub: helped ${stats.helpedCount}, reputation ${stats.reputation}, ${stats.activeRequests} active requests`}>
      <HandHeart size={15} aria-hidden="true" />
      {parts.flatMap((p, i) => (i ? [<span key={`d${i}`} aria-hidden="true">·</span>, p] : [p]))}
    </Link>
  );
}

function ProfileTabs({ profile }: { profile: Profile }) {
  const [params, setParams] = useSearchParams();
  const raw = params.get("tab");
  const tab: ProfileTab = raw === "replies" || raw === "media" ? raw : "posts";
  const list = useProfilePosts(profile.id, tab);
  const composer = useComposer();
  const who = profile.isViewer ? "You haven't" : `@${profile.handle} hasn't`;

  return (
    <>
      <div className="tabs profile-tabs" role="tablist" aria-label="Profile">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            id={`ptab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls="profile-panel"
            className="tab"
            onClick={() => setParams(t.id === "posts" ? {} : { tab: t.id }, { replace: true })}
          >
            {t.label}
          </button>
        ))}
      </div>

      <section id="profile-panel" role="tabpanel" aria-labelledby={`ptab-${tab}`} aria-busy={list.status === "loading"}>
        {list.status === "loading" && <FeedSkeleton />}
        {list.status === "error" && (
          <StateMessage
            tone="error"
            icon={<CircleAlert size={24} />}
            {...describeError(list.error)}
            action={<Button variant="secondary" onClick={list.retry}>Try again</Button>}
          />
        )}
        {list.status === "ready" && list.posts.length === 0 && (
          tab === "posts" ? (
            <StateMessage
              icon={<Feather size={24} />}
              title={`${who} posted yet`}
              body={profile.isViewer ? "Your posts will show up here." : "When they do, their posts will show up here."}
              action={profile.isViewer ? <Button onClick={() => composer.setOpen(true)}>Write your first post</Button> : undefined}
            />
          ) : tab === "replies" ? (
            <StateMessage icon={<MessageCircle size={24} />} title={`${who} replied to anyone yet`} />
          ) : (
            <StateMessage icon={<ImageIcon size={24} />} title={`${who} shared photos yet`} />
          )
        )}
        {list.status === "ready" && list.posts.length > 0 && (
          <>
            {tab === "media" ? <MediaGrid posts={list.posts} /> : list.posts.map((p) => <PostCard key={p.id} post={p} />)}
            <FeedFooter hasMore={list.hasMore} loading={list.loadingMore} onMore={list.loadMore} endLabel="" />
          </>
        )}
      </section>
    </>
  );
}

function HeaderSkeleton() {
  return (
    <div className="profile" aria-hidden="true">
      <Skeleton width={88} height={88} radius="50%" />
      <div style={{ display: "grid", gap: 10, marginTop: 16 }}>
        <Skeleton width={180} height={20} />
        <Skeleton width={110} height={12} />
        <Skeleton width="70%" height={12} />
        <Skeleton width={220} height={12} />
      </div>
    </div>
  );
}
