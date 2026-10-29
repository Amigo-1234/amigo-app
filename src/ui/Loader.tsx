import "./Loader.css";

/**
 * Branded loading mark: the Amigo bubble with its "a" drawing itself. Pure
 * CSS/SVG (transform + stroke only), so it stays smooth on phones and is
 * static under prefers-reduced-motion.
 */
export function AmigoLoader({ size = 56, label = "Loading" }: { size?: number; label?: string }) {
  return (
    <span className="amigo-loader" role="status" aria-label={label} style={{ width: size, height: size }}>
      <svg viewBox="0 0 32 32" width={size} height={size} aria-hidden="true">
        <path className="amigo-loader__bubble" d="M9 0h14a9 9 0 0 1 9 9v14a9 9 0 0 1-9 9H3a3 3 0 0 1-3-3V9a9 9 0 0 1 9-9z" />
        <circle className="amigo-loader__ring" cx="14.6" cy="17.2" r="5.6" pathLength="100" />
        <rect className="amigo-loader__stem" x="19.6" y="10" width="3.3" height="13" rx="1.65" />
      </svg>
    </span>
  );
}

/** Full-screen loading state (session restore, sign-in/out transitions). */
export function LoadingScreen({ label = "Loading Amigo World", message }: { label?: string; message?: string }) {
  return (
    <div className="loading-screen">
      <AmigoLoader label={label} />
      {message && <p className="loading-screen__msg" aria-hidden="true">{message}</p>}
    </div>
  );
}
