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
      onClick={(e) => {
        // Click on the backdrop (the dialog element itself, outside the panel).
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="sheet__panel">{open && children}</div>
    </dialog>
  );
}
