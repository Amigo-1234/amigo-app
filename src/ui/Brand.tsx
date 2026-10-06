import "./Brand.css";

/** The Amigo mark: a speech-bubble tile carrying a geometric lowercase "a". */
export function AmigoMark({ size = 28 }: { size?: number }) {
  return (
    <svg className="amigo-mark" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <path d="M9 0h14a9 9 0 0 1 9 9v14a9 9 0 0 1-9 9H3a3 3 0 0 1-3-3V9a9 9 0 0 1 9-9z" fill="var(--coral-500)" />
      <circle cx="14.6" cy="17.2" r="5.6" fill="none" stroke="var(--on-accent)" strokeWidth="3.2" />
      <rect x="19.6" y="10" width="3.3" height="13" rx="1.65" fill="var(--on-accent)" />
    </svg>
  );
}

export function Wordmark({ compact = false }: { compact?: boolean }) {
  return (
    <span className="wordmark">
      <AmigoMark />
      {!compact && <span className="wordmark__text">amigo</span>}
      <span className="visually-hidden">Amigo World</span>
    </span>
  );
}
