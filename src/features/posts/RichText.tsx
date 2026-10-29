import { Fragment, type ReactNode } from "react";
import { Link } from "react-router";
import { MENTION_RE } from "../../lib/mentions";
import { profileHref } from "../profile/links";

const URL_RE = /(https?:\/\/[^\s<]+[^\s<.,:;"')\]!?])/g;

/**
 * Renders user text safely (React escapes it): bare URLs become links, and
 * @mentions link to profiles (same rule the backend uses to notify).
 */
export function RichText({ text }: { text: string }) {
  const parts = text.split(URL_RE);
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <a key={i} href={part} target="_blank" rel="noopener noreferrer nofollow ugc" className="rich-link" onClick={(e) => e.stopPropagation()}>
            {part.replace(/^https?:\/\/(www\.)?/, "")}
          </a>
        ) : (
          <Fragment key={i}>{withMentions(part)}</Fragment>
        ),
      )}
    </>
  );
}

function withMentions(text: string): ReactNode {
  if (!profileHref("x") || !text.includes("@")) return text;
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(MENTION_RE)) {
    const start = m.index + m[1].length;
    out.push(text.slice(last, start));
    const handle = m[2];
    out.push(
      <Link key={start} to={profileHref(handle.toLowerCase())!} className="rich-link" onClick={(e) => e.stopPropagation()}>
        @{handle}
      </Link>,
    );
    last = start + handle.length + 1;
  }
  out.push(text.slice(last));
  return out;
}
