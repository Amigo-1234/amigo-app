import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { ArrowLeft, CircleAlert, UsersRound } from "lucide-react";
import { dataSource, type FollowListKind, type PersonSummary, type Profile } from "../data";
import { describeError } from "../features/feed/errors";
import { PersonRow } from "../features/profile/PersonRow";
import { ScreenHeader } from "../shell/ScreenHeader";
import { useViewer } from "../state/session";
import { Button, IconButton } from "../ui/Button";
import { Skeleton } from "../ui/Skeleton";
import { StateMessage } from "../ui/StateMessage";

type Load = { status: "loading" } | { status: "ready"; profile: Profile | null; people: PersonSummary[] } | { status: "error"; error: unknown };

export default function FollowListScreen({ kind }: { kind: FollowListKind }) {
  const { handle = "" } = useParams();
  const viewer = useViewer();
  const navigate = useNavigate();
  const [state, setState] = useState<Load>({ status: "loading" });
  const [key, setKey] = useState(0);

  useEffect(() => {
    const api = dataSource.profiles;
    if (!api) return;
    let cancelled = false;
    setState({ status: "loading" });
    (async () => {
      const profile = await api.getProfile(handle, viewer.id);
      const people = profile ? await api.listFollows(profile.id, kind, viewer.id) : [];
      if (!cancelled) setState({ status: "ready", profile, people });
    })().catch((error) => !cancelled && setState({ status: "error", error }));
    return () => {
      cancelled = true;
    };
  }, [handle, kind, viewer.id, key]);

  const profile = state.status === "ready" ? state.profile : null;
  const back = () => (window.history.state?.idx > 0 ? navigate(-1) : navigate(`/u/${handle}`));
  const self = profile?.isViewer;

  return (
    <>
      <ScreenHeader
        title={profile?.name ?? `@${handle}`}
        leading={
          <IconButton label="Back" onClick={back} className="back-btn">
            <ArrowLeft size={22} />
          </IconButton>
        }
      >
        <nav className="tabs" aria-label="Connections">
          <Link to={`/u/${handle}/following`} replace className="tab tab--link" aria-current={kind === "following" ? "page" : undefined}>
            Following
          </Link>
          <Link to={`/u/${handle}/followers`} replace className="tab tab--link" aria-current={kind === "followers" ? "page" : undefined}>
            Followers
          </Link>
        </nav>
      </ScreenHeader>

      {state.status === "loading" && (
        <ul aria-label="Loading" style={{ margin: 0, padding: 0 }}>
          {[0, 1, 2, 3, 4].map((i) => (
            <li key={i} className="person-row" aria-hidden="true">
              <Skeleton width={42} height={42} radius="50%" />
              <span style={{ display: "grid", gap: 6, flex: 1 }}>
                <Skeleton width={140} height={12} />
                <Skeleton width={90} height={10} />
              </span>
            </li>
          ))}
        </ul>
      )}

      {state.status === "error" && (
        <StateMessage tone="error" icon={<CircleAlert size={24} />} {...describeError(state.error)}
          action={<Button variant="secondary" onClick={() => setKey((k) => k + 1)}>Try again</Button>} />
      )}

      {state.status === "ready" && !profile && (
        <StateMessage icon={<UsersRound size={24} />} title="This account doesn't exist" />
      )}

      {state.status === "ready" && profile && state.people.length === 0 && (
        <StateMessage
          icon={<UsersRound size={24} />}
          title={
            kind === "followers"
              ? self ? "No followers yet" : `@${profile.handle} has no followers yet`
              : self ? "You're not following anyone yet" : `@${profile.handle} isn't following anyone yet`
          }
          body={self ? (kind === "followers" ? "When people follow you, they'll show up here." : "Find people worth following on Home.") : undefined}
        />
      )}

      {state.status === "ready" && profile && state.people.length > 0 && (
        <ul style={{ margin: 0, padding: 0 }}>
          {state.people.map((p) => <PersonRow key={p.id} person={p} />)}
        </ul>
      )}
    </>
  );
}
