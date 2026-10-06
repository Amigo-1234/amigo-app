import { useState, type CSSProperties } from "react";
import "./Avatar.css";

type Size = "xs" | "sm" | "md" | "lg" | "xl";

function hueFor(seed: string) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return h % 360;
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : (parts[0] ?? "?").slice(0, 2);
  return letters.toUpperCase();
}

export function Avatar({ name, src, seed, size = "md" }: { name: string; src?: string | null; seed?: string; size?: Size }) {
  const [failed, setFailed] = useState(false);
  const showImage = src && !failed;
  return (
    <span
      className={`avatar avatar--${size}`}
      style={showImage ? undefined : ({ "--avatar-hue": hueFor(seed ?? name) } as CSSProperties)}
      aria-hidden="true"
    >
      {showImage ? (
        <img src={src} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} />
      ) : (
        <span className="avatar__initials">{initials(name)}</span>
      )}
    </span>
  );
}
