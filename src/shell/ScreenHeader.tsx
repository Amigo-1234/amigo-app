import type { ReactNode } from "react";
import { Wordmark } from "../ui/Brand";
import "./ScreenHeader.css";

/**
 * Sticky, translucent header for every screen. On phones the Home screen
 * shows the wordmark here instead of a title.
 */
export function ScreenHeader({
  title,
  brandOnMobile = false,
  leading,
  actions,
  children,
}: {
  title: string;
  brandOnMobile?: boolean;
  leading?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="screen-header">
      <div className="screen-header__row">
        {leading}
        {brandOnMobile && (
          <span className="screen-header__brand">
            <Wordmark />
          </span>
        )}
        <h1 className={`screen-header__title${brandOnMobile ? " screen-header__title--desktop" : ""}`}>{title}</h1>
        <div className="screen-header__actions">{actions}</div>
      </div>
      {children}
    </header>
  );
}
