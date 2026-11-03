import type { ReactNode } from "react";
import "./StateMessage.css";

/** Shared empty / error / info block. Icons are line icons, never decoration emoji. */
export function StateMessage({
  icon,
  title,
  body,
  action,
  tone = "neutral",
}: {
  icon?: ReactNode;
  title: string;
  body?: ReactNode;
  action?: ReactNode;
  tone?: "neutral" | "error";
}) {
  return (
    <div className={`state-msg state-msg--${tone}`} role={tone === "error" ? "alert" : undefined}>
      {icon && <div className="state-msg__icon">{icon}</div>}
      <h2 className="state-msg__title">{title}</h2>
      {body && <p className="state-msg__body">{body}</p>}
      {action && <div className="state-msg__action">{action}</div>}
    </div>
  );
}
