import { Link } from "react-router";
import { Layers } from "lucide-react";
import type { Post } from "../../data";
import "./MediaGrid.css";

/** Square-cropped grid of a profile's media posts; each tile opens the post. */
export function MediaGrid({ posts }: { posts: Post[] }) {
  return (
    <ul className="media-grid">
      {posts.map((p) => {
        const first = p.media[0];
        if (!first) return null;
        return (
          <li key={p.id}>
            <Link to={`/post/${p.id}`} className="media-grid__tile" aria-label={p.text ? `Post: ${p.text.slice(0, 80)}` : `Photo by ${p.author.name}`}>
              {first.type === "video" ? (
                <video src={first.url} muted playsInline preload="metadata" />
              ) : (
                <img src={first.url} alt={first.alt ?? ""} loading="lazy" decoding="async" />
              )}
              {p.media.length > 1 && <Layers className="media-grid__multi" size={18} aria-hidden="true" />}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
