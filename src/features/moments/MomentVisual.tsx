import type { MediaItem, MomentBackground } from "../../data";
import "./Moments.css";

/**
 * What a Moment looks like: a photo, text on a background, or text over a
 * photo. Used by the viewer, the composer preview and admin review.
 */
export function MomentVisual({
  text,
  background,
  media,
  size = "full",
}: {
  text: string;
  background: MomentBackground;
  media: Pick<MediaItem, "url" | "alt"> | null;
  size?: "full" | "thumb";
}) {
  return (
    <div className={`moment-visual moment-bg--${background} moment-visual--${size}${media ? " has-photo" : ""}`}>
      {media && (
        <img
          key={media.url}
          className="moment-visual__photo"
          src={media.url}
          alt={media.alt ?? ""}
          draggable={false}
          // If the photo can't load, the background still shows (no broken-image icon).
          onError={(e) => (e.currentTarget.style.visibility = "hidden")}
        />
      )}
      {text && <p className={`moment-visual__text${media ? " moment-visual__text--over" : ""}`}>{text}</p>}
    </div>
  );
}
