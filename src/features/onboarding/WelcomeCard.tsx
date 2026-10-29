import { useEffect, useState } from "react";
import { Link } from "react-router";
import { Feather, HandHeart, Orbit, UserRoundPen, X } from "lucide-react";
import { dataSource, type PersonSummary } from "../../data";
import { useComposer } from "../../state/composer";
import { useViewer } from "../../state/session";
import { IconButton } from "../../ui/Button";
import { PersonRow } from "../profile/PersonRow";
import { profileHref } from "../profile/links";
import "./WelcomeCard.css";

const key = (id: string) => `amigo.welcome.done.${id}`;

/** Skipped on this device (Home shows other cards only after the welcome is out of the way). */
export function isWelcomeDismissed(id: string) {
  try {
    return localStorage.getItem(key(id)) === "1";
  } catch {
    return false;
  }
}

/**
 * First-run welcome on Home: a few people to follow and the next steps. One
 * card, skippable at any time; it goes away for good once dismissed (per
 * account, on this device) or once you follow someone and post.
 */
export function WelcomeCard({ followingCount, hasOwnPosts }: { followingCount: number; hasOwnPosts: boolean }) {
  const viewer = useViewer();
  const composer = useComposer();
  const [dismissed, setDismissed] = useState(() => isWelcomeDismissed(viewer.id));
  const [people, setPeople] = useState<PersonSummary[] | null>(null);
  const [followed, setFollowed] = useState(0);
  const done = dismissed || (followingCount + followed > 0 && hasOwnPosts);

  useEffect(() => {
    if (done) return;
    dataSource.getPeopleSuggestions(viewer.id, 3).then(setPeople, () => setPeople([]));
  }, [done, viewer.id]);

  if (done) return null;
  const dismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem(key(viewer.id), "1");
    } catch {
      /* private mode: it just shows again next visit */
    }
  };
  const me = profileHref(viewer.handle);

  return (
    <section className="welcome" aria-labelledby="welcome-title">
      <div className="welcome__head">
        <h2 id="welcome-title" className="welcome__title">Welcome to Amigo, {viewer.name.split(" ")[0]}</h2>
        <IconButton label="Skip the welcome" size="sm" onClick={dismiss}>
          <X size={18} />
        </IconButton>
      </div>
      <p className="welcome__sub">A few quick ways to get started — all optional.</p>

      {people && people.length > 0 && (
        <>
          <h3 className="welcome__step">Follow a few people</h3>
          <ul className="welcome__people">
            {people.map((p) => (
              <PersonRow key={p.id} person={p} onFollowChange={(f) => setFollowed((n) => n + (f ? 1 : -1))} />
            ))}
          </ul>
        </>
      )}

      <div className="welcome__actions">
        <button type="button" className="welcome__action" onClick={() => composer.setOpen(true)}>
          <Feather size={18} aria-hidden="true" /> Write your first post
        </button>
        {me && (
          <Link to={me} className="welcome__action">
            <UserRoundPen size={18} aria-hidden="true" /> Set up your profile
          </Link>
        )}
        {dataSource.worlds && (
          <Link to="/worlds" className="welcome__action">
            <Orbit size={18} aria-hidden="true" /> Worlds: live events to join
          </Link>
        )}
        {dataSource.support && (
          <Link to="/support" className="welcome__action">
            <HandHeart size={18} aria-hidden="true" /> Support Hub: back creators' projects
          </Link>
        )}
      </div>
    </section>
  );
}
