import type { CSSProperties } from "react";
import "./Skeleton.css";

export function Skeleton({ width, height, radius, style }: { width?: number | string; height?: number | string; radius?: number | string; style?: CSSProperties }) {
  return <span className="skeleton" style={{ width, height, borderRadius: radius, ...style }} aria-hidden="true" />;
}
