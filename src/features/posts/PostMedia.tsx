import { useState, type ReactNode } from "react";
import type { MediaItem } from "../../data";

const MIN_RATIO = 4 / 5; // tallest single-image crop (portrait)
const MAX_RATIO = 1.91; // widest single-image crop (landscape)
const MAX_TILES = 4;

function ratioOf(m: Pick<MediaItem, "width" | "height">): number | null {
  if (!m.width || !m.height) return null;
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, m.width / m.height));
}

export type LayoutItem = Pick<MediaItem, "type" | "url" | "width" | "height" | "alt" | "posterUrl">;

/**
 * The one media layout used everywhere posts appear (feed, profile, search,
 * post detail) and in the composer preview, so what you compose is what you get.
 *
 *   1 item   keeps its aspect ratio (clamped 4:5 – 1.91:1)
 *   2 items  side by side        ┐
 *   3 items  one large + 2 stacked ├ fixed 4:3 frame → no layout jump while loading
 *   4+ items 2×2, "+N" on the 4th ┘
 */
export function MediaLayout({
  items,
  onOpen,
  renderExtras,
  label,
  maxHeight,
}: {
  items: LayoutItem[];
  onOpen?: (index: number) => void;
  /** Extra controls on each tile (composer: remove / reorder). */
  renderExtras?: (index: number) => ReactNode;
  label?: (index: number, total: number) => string;
  /** Cap the rendered height (composer preview) without changing the arrangement. */
  maxHeight?: number;
}) {
  if (!items.length) return null;
  const shown = items.slice(0, MAX_TILES);
  const hidden = items.length - shown.length;
  const single = items.length === 1;
  const ratio = single ? ratioOf(items[0]) : null;

  return (
    <div
      className={`post-media post-media--${shown.length}${single && !ratio ? " post-media--natural" : ""}`}
      style={{
        ...(single && ratio ? { aspectRatio: ratio } : {}),
        ...(maxHeight ? { maxWidth: Math.round(maxHeight * (single ? ratio ?? 1 : 4 / 3)) } : {}),
      }}
    >
      {shown.map((m, i) => (
        <MediaTile
          key={`${m.url}-${i}`}
          item={m}
          index={i}
          total={items.length}
          more={i === MAX_TILES - 1 ? hidden : 0}
          onOpen={onOpen}
          extras={renderExtras?.(i)}
          label={label?.(i, items.length)}
        />
      ))}
    </div>
  );
}

function MediaTile({
  item,
  index,
  total,
  more,
  onOpen,
  extras,
  label,
}: {
  item: LayoutItem;
  index: number;
  total: number;
  more: number;
  onOpen?: (index: number) => void;
  extras?: ReactNode;
  label?: string;
}) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const name = label ?? (item.alt || (total > 1 ? `Image ${index + 1} of ${total}` : "Image"));

  const media = !item.url ? (
    <span className="media-tile__placeholder" aria-hidden="true" />
  ) : failed ? (
    <span className="media-tile__failed">Image unavailable</span>
  ) : item.type === "video" ? (
    <video src={item.url} poster={item.posterUrl} muted playsInline preload="metadata" onLoadedData={() => setLoaded(true)} />
  ) : (
    <img src={item.url} alt={item.alt ?? ""} loading="lazy" decoding="async" onLoad={() => setLoaded(true)} onError={() => setFailed(true)} />
  );

  return (
    <div className={`media-tile${loaded ? " is-loaded" : ""}`}>
      {onOpen ? (
        <button
          type="button"
          className="media-tile__open"
          onClick={(e) => {
            e.stopPropagation();
            onOpen(index);
          }}
          aria-label={more ? `View all ${total} images` : `View ${name.toLowerCase()} full screen`}
        >
          {media}
        </button>
      ) : (
        media
      )}
      {more > 0 && (
        <span className="media-tile__more" aria-hidden="true">
          +{more}
        </span>
      )}
      {extras}
    </div>
  );
}

/** Post attachments: opens the shared media viewer at the tapped item. */
export function PostMedia({ media, onOpen }: { media: MediaItem[]; onOpen: (index: number) => void }) {
  return <MediaLayout items={media} onOpen={onOpen} />;
}
