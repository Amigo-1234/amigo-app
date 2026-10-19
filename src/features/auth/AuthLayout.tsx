import type { ReactNode } from "react";
import { AmigoMark, Wordmark } from "../../ui/Brand";
import { CREATOR } from "../../lib/creator";
import "../../screens/AuthScreen.css";

/**
 * Frame for every signed-out screen: a brand panel (desktop) beside the form,
 * a compact brand header on phones. `stepKey` re-runs the enter transition
 * when the step changes.
 */
export function AuthLayout({ stepKey, children }: { stepKey: string; children: ReactNode }) {
  return (
    <div className="auth">
      <aside className="auth__aside" aria-hidden="true">
        <div className="auth__aside-inner">
          <AmigoMark size={64} />
          <p className="auth__aside-title">Your people.<br />Your world.</p>
          <p className="auth__aside-sub">Posts, Worlds and conversations with the people you actually like.</p>
        </div>
        <span className="auth__orb auth__orb--a" />
        <span className="auth__orb auth__orb--b" />
      </aside>
      <main className="auth__main">
        <div className="auth__brand">
          <Wordmark />
        </div>
        <div className="auth__card" key={stepKey}>
          {children}
        </div>
        <p className="auth__credit">
          Created by{" "}
          <a href={CREATOR.url} target="_blank" rel="noopener noreferrer">
            {CREATOR.studio}
          </a>
        </p>
      </main>
    </div>
  );
}

export function AuthHeading({ title, sub }: { title: string; sub?: ReactNode }) {
  return (
    <header className="auth__head">
      <h1 className="auth__title">{title}</h1>
      {sub && <p className="auth__sub">{sub}</p>}
    </header>
  );
}
