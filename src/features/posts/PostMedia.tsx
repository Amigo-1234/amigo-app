import { useState } from "react";
import type { MediaItem } from "../../data";

const MIN_RATIO = 4 / 5; // tallest allowed crop (portrait)
const MAX_RATIO = 1.91; // widest allowed crop (landscape)

function ratioOf(m: MediaItem): number | null {
  if (!m.width || !m.height) return null;
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, m.width / m.height));
}

function MediaTile({ item, onOpen, ratio, index, total }: { item: MediaItem; onOpen: () => void; ratio: number | null; index: number; total: number }) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const label = item.alt || (total > 1 ? `Image ${index + 1} of ${total}` : "Image");

  if (item.type === "video") {
    return (
      <div className="media-tile" style={ratio ? { aspectRatio: ratio } : undefined}>
        <video src={item.url} controls playsInline preload="metadata" aria-label={item.alt || "Video"} onClick={(e) => e.stopPropagation()} />
      </div>
    );
  }

  return (
    <button
      type="button"
      className={`media-tile${loaded ? " is-loaded" : ""}${ratio ? "" : " media-tile--natural"}`}
      style={ratio ? { aspectRatio: ratio } : undefined}
      onClick={(e) => {
        e.stopPropagation();
        onOpen();
      }}
      aria-label={`View ${label.toLowerCase()} full screen`}
    >
      {failed ? (
        <span className="media-tile__failed">Image unavailable</span>
      ) : (
        <img src={item.url} alt={item.alt ?? ""} loading="lazy" decoding="async" onLoad={() => setLoaded(true)} onError={() => setFailed(true)} />
      )}
    </button>
  );
}

export function PostMedia({ media, onOpen }: { media: MediaItem[]; onOpen: (index: number) => void }) {
  if (!media.length) return null;
  const single = media.length === 1;
  return (
    <div className={`post-media post-media--${Math.min(media.length, 4)}`}>
      {media.slice(0, 4).map((m, i) => (
        <MediaTile key={i} item={m} index={i} total={media.length} ratio={single ? ratioOf(m) : 1} onOpen={() => onOpen(i)} />
      ))}
    </div>
  );
}
