import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import type { MediaItem } from "../../data";
import "./MediaViewer.css";

const ViewerContext = createContext<(item: MediaItem) => void>(() => {});

/** One full-screen viewer for the whole app; posts call useMediaViewer()(item). */
export function MediaViewerProvider({ children }: { children: ReactNode }) {
  const [item, setItem] = useState<MediaItem | null>(null);
  const ref = useRef<HTMLDialogElement>(null);
  const close = () => setItem(null);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (item && !d.open) d.showModal();
    if (!item && d.open) d.close();
  }, [item]);

  return (
    <ViewerContext.Provider value={setItem}>
      {children}
      <dialog
        ref={ref}
        className="media-viewer"
        aria-label="Media viewer"
        onCancel={(e) => {
          e.preventDefault();
          close();
        }}
        onClick={close}
      >
        <button className="media-viewer__close" onClick={close} aria-label="Close">
          <X size={22} />
        </button>
        {item && <img src={item.url} alt={item.alt ?? ""} onClick={(e) => e.stopPropagation()} />}
      </dialog>
    </ViewerContext.Provider>
  );
}

export const useMediaViewer = () => useContext(ViewerContext);
