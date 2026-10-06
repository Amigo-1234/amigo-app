import { Link } from "react-router";
import type { PersonSummary } from "../../data";
import { Avatar } from "../../ui/Avatar";
import { FollowButton } from "./FollowButton";
import { profileHref } from "./links";
import "./PersonRow.css";

/** One person in a list (follow lists, suggestions). The whole row links to their profile. */
export function PersonRow({ person, onFollowChange }: { person: PersonSummary; onFollowChange?: (following: boolean) => void }) {
  const href = profileHref(person.handle);
  const body = (
    <>
      <Avatar name={person.name} src={person.avatarUrl} seed={person.id} size="md" />
      <span className="person-row__text">
        <span className="person-row__name">{person.name}</span>
        <span className="person-row__handle">@{person.handle}</span>
        {person.bio && <span className="person-row__bio">{person.bio}</span>}
      </span>
    </>
  );
  return (
    <li className="person-row">
      {href ? (
        <Link to={href} className="person-row__main">
          {body}
        </Link>
      ) : (
        <span className="person-row__main">{body}</span>
      )}
      <FollowButton personId={person.id} personName={person.name} following={person.viewerFollows} onChange={onFollowChange} />
    </li>
  );
}
