import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router";
import { dataSource, type CreatorApplication, type FraudFlag, type LegalSlug, type LegalVersion, type MonetizationSettings } from "../../data";
import { LEGAL_DOCS, loadLegalText } from "../../legal";
import { timeAgo } from "../../lib/time";
import { useViewer } from "../../state/session";
import { useToast } from "../../state/toast";
import { Avatar } from "../../ui/Avatar";
import { Button } from "../../ui/Button";
import { supportErrorText } from "../support/useSupport";

const dateInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);

/** Admin → Legal: published versions and publishing a new one. Text ships with the app per version. */
export function AdminLegal() {
  const api = dataSource.admin!.legal!;
  const toast = useToast();
  const [docs, setDocs] = useState<LegalVersion[] | null>(null);
  const [slug, setSlug] = useState<LegalSlug>("terms");
  const [version, setVersion] = useState("");
  const [effective, setEffective] = useState(dateInput(new Date()));
  const [material, setMaterial] = useState(false);
  const [summary, setSummary] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => void api.list().then(setDocs), [api]);
  useEffect(load, [load]);

  async function publish(e: FormEvent) {
    e.preventDefault();
    if (!/^\d+\.\d+$/.test(version)) return toast("Version looks like 1.0", "error");
    if (!(await loadLegalText(slug, version))) return toast(`This app build has no text for ${slug} ${version}. Add src/legal/docs/${slug}-${version}.md and deploy first.`, "error");
    if (!window.confirm(`Publish ${slug} v${version}?${material ? " Everyone will be asked to accept it again." : ""}`)) return;
    setBusy(true);
    try {
      const doc = LEGAL_DOCS.find((d) => d.slug === slug)!;
      await api.publish({
        slug,
        version,
        title: doc.title,
        effectiveAt: new Date(`${effective}T00:00:00`),
        requiresAcceptance: slug === "terms" || slug === "privacy",
        materialChange: material,
        summary,
      });
      toast(`Published ${doc.title} v${version}`);
      setVersion("");
      setSummary("");
      setMaterial(false);
      load();
    } catch (err) {
      toast(supportErrorText(err), "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <section className="admin-card" aria-labelledby="legal-pub">
        <h2 id="legal-pub" className="admin-card__title">Publish a new version</h2>
        <p className="admin-muted">
          Add the reviewed text as <code>src/legal/docs/&lt;slug&gt;-&lt;version&gt;.md</code> and deploy first. Versions 0.x show as drafts. A material
          change asks everyone who accepted an earlier version to accept again; other changes show a notice.
        </p>
        <form className="admin-user__form" onSubmit={publish}>
          <label className="admin-filter">
            Document
            <select value={slug} onChange={(e) => setSlug(e.target.value as LegalSlug)}>
              {LEGAL_DOCS.map((d) => (
                <option key={d.slug} value={d.slug}>{d.title}</option>
              ))}
            </select>
          </label>
          <input className="field__input" value={version} onChange={(e) => setVersion(e.target.value)} placeholder="Version, e.g. 1.0" aria-label="Version" />
          <label className="admin-filter">
            Effective
            <input type="date" value={effective} onChange={(e) => setEffective(e.target.value)} />
          </label>
          <input className="field__input" value={summary} maxLength={500} onChange={(e) => setSummary(e.target.value)} placeholder="What changed (shown to people)" aria-label="Change summary" />
          <label className="admin-filter">
            <input type="checkbox" checked={material} onChange={(e) => setMaterial(e.target.checked)} /> Material change — require acceptance again
          </label>
          <Button type="submit" size="sm" loading={busy} disabled={busy || !version}>
            Publish
          </Button>
        </form>
      </section>

      <section className="admin-card" aria-labelledby="legal-list">
        <h2 id="legal-list" className="admin-card__title">Versions</h2>
        {!docs ? (
          <p className="admin-muted">Loading…</p>
        ) : (
          <ul className="admin-rows">
            {docs.map((d) => (
              <li key={`${d.slug}-${d.version}`} className="admin-row">
                <Link to={`/legal/${d.slug}`} className="admin-row__title">
                  {d.title} v{d.version}
                </Link>
                <span className="admin-muted">
                  {" "}
                  · effective {d.effectiveAt.toLocaleDateString()} · {d.publishedAt ? `published ${timeAgo(d.publishedAt)}` : "draft"}
                  {d.materialChange && " · material change"}
                  {d.requiresAcceptance && " · requires acceptance"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

const FLAG_KINDS: { id: FraudFlag["kind"]; label: string }[] = [
  { id: "support_farming", label: "Support farming" },
  { id: "fake_followers", label: "Fake followers" },
  { id: "engagement_manipulation", label: "Engagement manipulation" },
  { id: "duplicate_accounts", label: "Duplicate accounts" },
  { id: "other", label: "Other" },
];

/** Admin → Monetization: programme switches, criteria, applications, statuses, fraud flags. Nothing financial. */
export function AdminMonetization() {
  const api = dataSource.admin!.monetization!;
  const viewer = useViewer();
  const toast = useToast();
  const [settings, setSettings] = useState<MonetizationSettings | null>(null);
  const [criteriaText, setCriteriaText] = useState("{}");
  const [apps, setApps] = useState<CreatorApplication[] | null>(null);
  const [flags, setFlags] = useState<FraudFlag[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [handle, setHandle] = useState("");
  const [flagKind, setFlagKind] = useState<FraudFlag["kind"]>("support_farming");
  const [reason, setReason] = useState("");

  const load = useCallback(() => {
    void api.settings().then((s) => {
      setSettings(s);
      setCriteriaText(JSON.stringify(s.criteria, null, 2));
    });
    void api.applications("pending").then(setApps);
    void api.flags(true).then(setFlags);
  }, [api]);
  useEffect(load, [load]);

  const run = async (fn: () => Promise<void>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      toast(ok);
      load();
    } catch (e) {
      toast(supportErrorText(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const findUserId = async (h: string) => (await dataSource.admin!.users.find(viewer.id, h))?.person.id ?? null;

  if (!settings) return <p className="admin-muted">Loading…</p>;

  return (
    <>
      <section className="admin-card" aria-labelledby="mon-prog">
        <h2 id="mon-prog" className="admin-card__title">Programme</h2>
        <p className="admin-muted">
          Architecture only. No payments, earnings, balances or payouts exist, and none can be switched on here. Opening the programme only changes what
          creators are told; approving an application marks a creator eligible, nothing more.
        </p>
        <form
          className="admin-user__form"
          onSubmit={(e) => {
            e.preventDefault();
            let criteria: Record<string, unknown>;
            try {
              criteria = JSON.parse(criteriaText || "{}");
              if (typeof criteria !== "object" || Array.isArray(criteria) || criteria === null) throw new Error();
            } catch {
              return toast("Criteria must be a JSON object", "error");
            }
            void run(() => api.saveSettings({ programmeOpen: settings.programmeOpen, applicationsOpen: settings.applicationsOpen, criteria, publicNote: settings.publicNote }), "Saved");
          }}
        >
          <label className="admin-filter">
            <input type="checkbox" checked={settings.programmeOpen} onChange={(e) => setSettings({ ...settings, programmeOpen: e.target.checked })} /> Programme open
          </label>
          <label className="admin-filter">
            <input type="checkbox" checked={settings.applicationsOpen} onChange={(e) => setSettings({ ...settings, applicationsOpen: e.target.checked })} /> Accept
            applications
          </label>
          <label className="admin-filter" htmlFor="mon-criteria">
            Published criteria (JSON, shown to creators; empty until officially configured)
          </label>
          <textarea id="mon-criteria" className="field__input admin-textarea" rows={4} value={criteriaText} onChange={(e) => setCriteriaText(e.target.value)} />
          <input className="field__input" maxLength={500} value={settings.publicNote} onChange={(e) => setSettings({ ...settings, publicNote: e.target.value })} placeholder="Public note for creators" aria-label="Public note" />
          <Button type="submit" size="sm" loading={busy} disabled={busy}>
            Save
          </Button>
        </form>
      </section>

      <section className="admin-card" aria-labelledby="mon-apps">
        <h2 id="mon-apps" className="admin-card__title">Applications waiting</h2>
        {!apps ? (
          <p className="admin-muted">Loading…</p>
        ) : apps.length === 0 ? (
          <p className="admin-muted">No pending applications.</p>
        ) : (
          <ul className="admin-rows">
            {apps.map((a) => (
              <li key={a.id} className="admin-row">
                <div className="admin-user__who">
                  <Avatar name={a.person.name} src={a.person.avatarUrl} seed={a.person.id} size="sm" />
                  <div>
                    <Link to={`/u/${a.person.handle}`} className="admin-row__title">@{a.person.handle}</Link>
                    <p className="admin-muted">
                      Applied {timeAgo(a.submittedAt)} · {a.current.verifiedFollowers} verified followers · {a.current.supportReceived} verified support ·{" "}
                      {a.current.posts30d} posts/30d · {a.current.accountAgeDays} days old
                      {a.current.openFraudFlags > 0 && <strong> · {a.current.openFraudFlags} open fraud flag(s)</strong>}
                    </p>
                  </div>
                </div>
                <div className="admin-inline">
                  <Button size="sm" disabled={busy} onClick={() => void run(() => api.review(a.id, "approved", reason), "Approved")}>
                    Approve
                  </Button>
                  <Button size="sm" variant="danger" disabled={busy} onClick={() => void run(() => api.review(a.id, "rejected", reason), "Rejected")}>
                    Reject
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
        <input className="field__input" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Note for the decision (shown to the creator)" aria-label="Decision note" />
      </section>

      <section className="admin-card" aria-labelledby="mon-status">
        <h2 id="mon-status" className="admin-card__title">Creator status and fraud flags</h2>
        <div className="admin-user__form">
          <input className="field__input" value={handle} onChange={(e) => setHandle(e.target.value)} placeholder="@username" aria-label="Username" />
          <input className="field__input" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} placeholder="Reason (required, audited)" aria-label="Reason" />
          <div className="admin-inline">
            {(["eligible", "not_eligible", "suspended"] as const).map((st) => (
              <Button
                key={st}
                size="sm"
                variant={st === "suspended" ? "danger" : "secondary"}
                disabled={busy || !handle.trim() || reason.trim().length < 3}
                onClick={() =>
                  void run(async () => {
                    const id = await findUserId(handle);
                    if (!id) throw new Error("No one with that username");
                    await api.setStatus(id, st, reason);
                  }, `Status set to ${st.replace("_", " ")}`)
                }
              >
                {st === "eligible" ? "Mark eligible" : st === "not_eligible" ? "Not eligible" : "Suspend"}
              </Button>
            ))}
          </div>
          <div className="admin-inline">
            <select value={flagKind} onChange={(e) => setFlagKind(e.target.value as FraudFlag["kind"])} aria-label="Flag type">
              {FLAG_KINDS.map((k) => (
                <option key={k.id} value={k.id}>{k.label}</option>
              ))}
            </select>
            <Button
              size="sm"
              variant="secondary"
              disabled={busy || !handle.trim()}
              onClick={() =>
                void run(async () => {
                  const id = await findUserId(handle);
                  if (!id) throw new Error("No one with that username");
                  await api.flag(id, flagKind, reason);
                }, "Flag raised")
              }
            >
              Raise flag
            </Button>
          </div>
        </div>
        {flags && flags.length > 0 && (
          <ul className="admin-rows">
            {flags.map((f) => (
              <li key={f.id} className="admin-row">
                <span className="admin-row__title">@{f.handle}</span>
                <span className="admin-muted"> · {FLAG_KINDS.find((k) => k.id === f.kind)?.label} · {timeAgo(f.createdAt)}{f.detail && ` · ${f.detail}`}</span>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(() => api.resolveFlag(f.id), "Resolved")}>
                  Resolve
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
