import { useEffect, useRef, type ReactNode } from "react";
import "./Sheet.css";

/**
 * Modal sheet built on <dialog>: native focus trapping, Esc to close and
 * top-layer stacking. Bottom sheet on phones, centered panel on larger screens.
 */
export function Sheet({
  open,
  onClose,
  label,
  children,
  fullscreenOnMobile = false,
}: {
  open: boolean;
  onClose: () => void;
  label: string;
  children: ReactNode;
  fullscreenOnMobile?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  /** Where the current press started: only a press that starts and ends on the backdrop closes. */
  const downOnBackdrop = useRef(false);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className={`sheet${fullscreenOnMobile ? " sheet--full" : ""}`}
      aria-label={label}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onPointerDown={(e) => {
        downOnBackdrop.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        // Click on the backdrop (the dialog element itself, outside the panel). A press that
        // began inside the panel (dragging a slider, scrolling, selecting text) and ended out
        // here also arrives as a click on the dialog: that one mustn't close it.
        const fromBackdrop = downOnBackdrop.current;
        downOnBackdrop.current = false;
        if (e.target === e.currentTarget && fromBackdrop) onClose();
      }}
    >
      <div className="sheet__panel">{open && children}</div>
    </dialog>
  );
}
