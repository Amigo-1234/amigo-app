import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { ArrowLeft, ChevronRight, FileText } from "lucide-react";
import { dataSource, type LegalSlug, type LegalVersion } from "../data";
import { BUNDLED_VERSION, isDraft, LEGAL_DOCS, loadLegalText } from "../legal";
import { Markdown } from "../legal/Markdown";
import { Wordmark } from "../ui/Brand";
import { AmigoLoader } from "../ui/Loader";
import "./LegalScreen.css";

const dateFmt = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "long", year: "numeric" });

/** Current versions from the backend, cached for the session (public; works signed out). */
let currentCache: Promise<LegalVersion[] | null> | null = null;
export function legalCurrent(): Promise<LegalVersion[] | null> {
  currentCache ??= dataSource.legal ? dataSource.legal.current().catch(() => null) : Promise.resolve(null);
  return currentCache;
}

/** /legal and /legal/:slug — public pages, signed in or out. */
export default function LegalScreen() {
  const { slug } = useParams();
  const navigate = useNavigate();
  const doc = LEGAL_DOCS.find((d) => d.slug === slug);
  const [current, setCurrent] = useState<LegalVersion[] | null | undefined>(undefined);
  const [text, setText] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    void legalCurrent().then(setCurrent);
  }, []);

  const meta = doc ? current?.find((c) => c.slug === doc.slug) : undefined;
  const version = doc ? (meta?.version ?? BUNDLED_VERSION[doc.slug as LegalSlug]) : "";

  useEffect(() => {
    if (!doc || current === undefined) return;
    setText(undefined);
    void loadLegalText(doc.slug, version).then(setText);
  }, [doc, version, current]);

  useEffect(() => {
    document.title = doc ? `${doc.title} · Amigo World` : "Legal · Amigo World";
    window.scrollTo(0, 0);
  }, [doc]);

  const back = () => (window.history.state?.idx > 0 ? navigate(-1) : navigate(slug ? "/legal" : "/"));

  return (
    <div className="legal">
      <header className="legal__bar">
        <button type="button" className="legal__back" onClick={back} aria-label="Back">
          <ArrowLeft size={22} />
        </button>
        <Link to="/" className="legal__brand" aria-label="Amigo World home">
          <Wordmark />
        </Link>
      </header>

      <main className="legal__main">
        {!slug && (
          <>
            <h1 className="legal__title">Legal</h1>
            <p className="legal__lead">How Amigo works, what we expect from everyone, and how we handle your information.</p>
            <ul className="legal__list">
              {LEGAL_DOCS.map((d) => (
                <li key={d.slug}>
                  <Link to={`/legal/${d.slug}`} className="legal__row">
                    <FileText size={20} aria-hidden="true" />
                    <span>
                      <strong>{d.title}</strong>
                      <span>{d.blurb}</span>
                    </span>
                    <ChevronRight size={18} aria-hidden="true" />
                  </Link>
                </li>
              ))}
            </ul>
          </>
        )}

        {slug && !doc && (
          <>
            <h1 className="legal__title">Document not found</h1>
            <p className="legal__lead">
              <Link to="/legal">See all legal documents</Link>
            </p>
          </>
        )}

        {doc && (
          <article className="legal__doc">
            <p className="legal__meta">
              Version {version}
              {meta && <> · Effective {dateFmt.format(meta.effectiveAt)}</>}
              {meta?.publishedAt && <> · Last updated {dateFmt.format(meta.publishedAt)}</>}
            </p>
            {isDraft(version) && (
              <p className="legal__draft" role="note">
                Draft — pending legal review before public launch.
              </p>
            )}
            {text === undefined && (
              <div className="legal__loading">
                <AmigoLoader size={40} label="Loading document" />
              </div>
            )}
            {text === null && <p className="legal__lead">This version isn't available in this version of the app. Refresh to get the latest.</p>}
            {text && <Markdown text={text} />}
          </article>
        )}
      </main>

      <footer className="legal__footer">
        <nav aria-label="Legal documents">
          {LEGAL_DOCS.map((d) => (
            <Link key={d.slug} to={`/legal/${d.slug}`}>
              {d.title}
            </Link>
          ))}
        </nav>
      </footer>
    </div>
  );
}
