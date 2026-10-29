import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router";
import {
  dataSource,
  type AdminAuditEntry,
  type PersonSummary,
  type SupportAdminAction,
  type SupportReport,
  type SupportRequest,
  type SupportStatus,
  type SupportWallet,
  type SuspiciousSupport,
} from "../../data";
import { categoryLabel } from "../../data/supportRules";
import { timeAgo } from "../../lib/time";
import { useViewer } from "../../state/session";
import { useToast } from "../../state/toast";
import { Button } from "../../ui/Button";
import { statusLabel } from "../support/SupportCard";
import { supportErrorText } from "../support/useSupport";
import { AuditList } from "./AdminSections";

const TABS = [
  { id: "requests", label: "Requests" },
  { id: "reports", label: "Reports" },
  { id: "activity", label: "Activity" },
  { id: "credits", label: "Credits" },
  { id: "audit", label: "Audit log" },
] as const;

const DONE: Record<SupportAdminAction, string> = {
  approve: "Approved",
  reject: "Rejected — credits refunded",
  remove: "Removed",
  close: "Closed",
  reopen: "Reopened",
  feature: "Featured",
  unfeature: "No longer featured",
};

const STATUSES: (SupportStatus | "all")[] = ["pending", "active", "completed", "closed", "rejected", "removed", "all"];

export function SupportAdmin() {
  const [params, setParams] = useSearchParams();
  const tab = TABS.find((t) => t.id === params.get("tab"))?.id ?? "requests";
  return (
    <>
      <div className="admin-subnav" role="tablist" aria-label="Support Hub admin">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className="chip" onClick={() => setParams(t.id === "requests" ? {} : { tab: t.id }, { replace: true })}>
            {t.label}
          </button>
        ))}
      </div>
      {tab === "requests" && <Requests />}
      {tab === "reports" && <Reports />}
      {tab === "activity" && <Activity />}
      {tab === "credits" && <Credits />}
      {tab === "audit" && <Audit />}
    </>
  );
}

function useAdminAction() {
  const viewer = useViewer();
  const toast = useToast();
  return async (fn: (a: NonNullable<typeof dataSource.admin>["support"], adminId: string) => Promise<void>, ok: string) => {
    try {
      await fn(dataSource.admin!.support, viewer.id);
      toast(ok);
      return true;
    } catch (e) {
      toast(supportErrorText(e), "error");
      return false;
    }
  };
}

function Requests() {
  const viewer = useViewer();
  const [params, setParams] = useSearchParams();
  const status = (STATUSES.find((s) => s === params.get("status")) ?? "pending") as SupportStatus | "all";
  const [rows, setRows] = useState<SupportRequest[] | null>(null);
  const [inspect, setInspect] = useState<string | null>(null);
  const act = useAdminAction();
  const load = useCallback(() => void dataSource.admin!.support.listRequests(viewer.id, status).then(setRows), [viewer.id, status]);
  useEffect(() => {
    setRows(null);
    load();
  }, [load]);

  const run = async (r: SupportRequest, action: SupportAdminAction) => {
    if (action === "remove" && !window.confirm(`Remove “${r.title}”? It disappears for everyone; the creator's credits aren't refunded.`)) return;
    if (await act((a, id) => a.moderate(id, r.id, action), DONE[action])) load();
  };

  return (
    <section className="admin-card" aria-label="Support requests">
      <label className="admin-filter">
        Status
        <select value={status} onChange={(e) => setParams({ status: e.target.value }, { replace: true })}>
          {STATUSES.map((s) => (
            <option key={s} value={s}>{s === "all" ? "All" : s[0].toUpperCase() + s.slice(1)}</option>
          ))}
        </select>
      </label>
      {!rows ? (
        <p className="admin-muted">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="admin-muted">No {status === "all" ? "" : `${status} `}requests.</p>
      ) : (
        <ul className="admin-rows">
          {rows.map((r) => (
            <li key={r.id} className="admin-row">
              <div className="admin-row__main">
                <Link to={`/support/${r.id}`} className="admin-row__title">{r.title}</Link>
                <span className="admin-muted">
                  @{r.creator.handle} · {categoryLabel(r.category)} · {r.supporterCount}/{r.target} supporters · {timeAgo(r.createdAt)}
                </span>
                <span className="admin-row__tags">
                  <span className={`support-tag support-tag--${r.status}`}>{statusLabel(r)}</span>
                  {r.featured && <span className="support-tag support-tag--featured">Featured</span>}
                </span>
              </div>
              <div className="admin-row__actions">
                {r.status === "pending" && (
                  <>
                    <Button size="sm" onClick={() => run(r, "approve")}>Approve</Button>
                    <Button size="sm" variant="secondary" onClick={() => run(r, "reject")}>Reject</Button>
                  </>
                )}
                {r.status === "active" && <Button size="sm" variant="secondary" onClick={() => run(r, "close")}>Close</Button>}
                {(r.status === "closed" || r.status === "removed") && <Button size="sm" variant="secondary" onClick={() => run(r, "reopen")}>Reopen</Button>}
                {r.status !== "removed" && r.status !== "rejected" && (
                  <Button size="sm" variant="ghost" onClick={() => run(r, r.featured ? "unfeature" : "feature")}>{r.featured ? "Unfeature" : "Feature"}</Button>
                )}
                {r.status !== "removed" && r.status !== "rejected" && <Button size="sm" variant="danger" onClick={() => run(r, "remove")}>Remove</Button>}
                <Button size="sm" variant="ghost" aria-expanded={inspect === r.id} onClick={() => setInspect(inspect === r.id ? null : r.id)}>
                  Supporters
                </Button>
              </div>
              {inspect === r.id && <Supporters requestId={r.id} />}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Supporters({ requestId }: { requestId: string }) {
  const viewer = useViewer();
  const [rows, setRows] = useState<Awaited<ReturnType<NonNullable<typeof dataSource.admin>["support"]["supporters"]>> | null>(null);
  useEffect(() => void dataSource.admin!.support.supporters(viewer.id, requestId).then(setRows), [viewer.id, requestId]);
  if (!rows) return <p className="admin-muted admin-row__more">Loading…</p>;
  if (!rows.length) return <p className="admin-muted admin-row__more">Nobody has opened this yet.</p>;
  return (
    <table className="admin-table admin-row__more">
      <thead>
        <tr><th>Person</th><th>Opened</th><th>Confirmed after</th></tr>
      </thead>
      <tbody>
        {rows.map((s) => (
          <tr key={s.person.id}>
            <td>@{s.person.handle}</td>
            <td>{timeAgo(s.openedAt)}</td>
            <td className={s.seconds !== null && s.seconds < 20 ? "is-flag" : ""}>{s.seconds === null ? "not confirmed" : `${s.seconds}s`}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Reports() {
  const viewer = useViewer();
  const [all, setAll] = useState(false);
  const [rows, setRows] = useState<SupportReport[] | null>(null);
  const act = useAdminAction();
  const load = useCallback(() => void dataSource.admin!.support.listReports(viewer.id, all ? "all" : "open").then(setRows), [viewer.id, all]);
  useEffect(load, [load]);
  return (
    <section className="admin-card" aria-label="Reports">
      <label className="admin-filter">
        <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Show resolved
      </label>
      {!rows ? (
        <p className="admin-muted">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="admin-muted">No open reports.</p>
      ) : (
        <ul className="admin-rows">
          {rows.map((x) => (
            <li key={x.id} className="admin-row">
              <div className="admin-row__main">
                <Link to={`/support/${x.request.id}`} className="admin-row__title">{x.request.title}</Link>
                <span>“{x.reason}”</span>
                <span className="admin-muted">
                  Reported by @{x.reporter.handle} · {timeAgo(x.createdAt)} · request is {x.request.status} · report {x.status}
                </span>
              </div>
              {x.status === "open" && (
                <div className="admin-row__actions">
                  {x.request.status !== "removed" && (
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={async () => {
                        if (!window.confirm(`Remove “${x.request.title}”?`)) return;
                        if (await act(async (a, id) => { await a.moderate(id, x.request.id, "remove", `report ${x.id}`); await a.resolveReport(id, x.id, "actioned"); }, "Request removed")) load();
                      }}
                    >
                      Remove request
                    </Button>
                  )}
                  <Button size="sm" variant="secondary" onClick={async () => (await act((a, id) => a.resolveReport(id, x.id, x.request.status === "removed" ? "actioned" : "dismissed"), "Report resolved")) && load()}>
                    {x.request.status === "removed" ? "Mark resolved" : "Dismiss"}
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const KIND: Record<SuspiciousSupport["kind"], string> = { "quick-confirm": "Quick confirm", burst: "Burst", mutual: "Mutual" };

function Activity() {
  const viewer = useViewer();
  const [rows, setRows] = useState<SuspiciousSupport[] | null>(null);
  useEffect(() => void dataSource.admin!.support.suspicious(viewer.id).then(setRows), [viewer.id]);
  return (
    <section className="admin-card" aria-label="Suspicious activity">
      <p className="admin-muted">
        Patterns worth a look, from real timestamps: confirmations within 20 seconds of opening a link, and many supports in a few minutes. Nothing here is automatic — use Credits to correct a balance if needed.
      </p>
      {!rows ? (
        <p className="admin-muted">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="admin-muted">Nothing flagged.</p>
      ) : (
        <ul className="admin-rows">
          {rows.map((x, i) => (
            <li key={i} className="admin-row">
              <div className="admin-row__main">
                <span>
                  <span className="support-tag support-tag--flag">{KIND[x.kind]}</span> <strong>@{x.person.handle}</strong> — {x.detail}
                </span>
                <span className="admin-muted">
                  {timeAgo(x.at)}
                  {x.requestId && <> · <Link to={`/support/${x.requestId}`}>open request</Link></>}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Credits() {
  const viewer = useViewer();
  const toast = useToast();
  const [handle, setHandle] = useState("");
  const [person, setPerson] = useState<(PersonSummary & { wallet: SupportWallet }) | null | undefined>(undefined);
  const [delta, setDelta] = useState("");
  const [note, setNote] = useState("");
  const act = useAdminAction();
  const find = async (e: FormEvent) => {
    e.preventDefault();
    setPerson(await dataSource.admin!.support.findUser(viewer.id, handle));
  };
  const apply = async (e: FormEvent) => {
    e.preventDefault();
    const n = Number(delta);
    if (!person || !Number.isInteger(n) || n === 0) return toast("Enter a whole number, e.g. 5 or -3", "error");
    if (await act((a, id) => a.adjustCredits(id, person.id, n, note), `Credits adjusted for @${person.handle}`)) {
      setPerson(await dataSource.admin!.support.findUser(viewer.id, person.handle));
      setDelta("");
      setNote("");
    }
  };
  return (
    <section className="admin-card" aria-label="Adjust Support Credits">
      <p className="admin-muted">Manual corrections only (e.g. reversing farmed credits). Reputation can't be edited. Every change needs a reason and is written to the audit log.</p>
      <form className="admin-inline" onSubmit={find}>
        <label className="visually-hidden" htmlFor="admin-handle">Username</label>
        <input id="admin-handle" className="field__input" value={handle} onChange={(e) => setHandle(e.target.value)} placeholder="@username" />
        <Button type="submit" size="sm" variant="secondary" disabled={!handle.trim()}>Find</Button>
      </form>
      {person === null && <p className="admin-muted">No one with that username.</p>}
      {person && (
        <form className="admin-credits" onSubmit={apply}>
          <p>
            <strong>{person.name}</strong> @{person.handle} — <strong>{person.wallet.credits}</strong> credits · {person.wallet.reputation} reputation · helped {person.wallet.helpedCount}
          </p>
          <div className="admin-inline">
            <label className="visually-hidden" htmlFor="admin-delta">Change</label>
            <input id="admin-delta" className="field__input admin-num" inputMode="numeric" value={delta} onChange={(e) => setDelta(e.target.value)} placeholder="+5 / -3" />
            <label className="visually-hidden" htmlFor="admin-note">Reason</label>
            <input id="admin-note" className="field__input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Reason (required)" />
            <Button type="submit" size="sm" disabled={!delta.trim() || note.trim().length < 3}>Apply</Button>
          </div>
        </form>
      )}
    </section>
  );
}

function Audit() {
  const viewer = useViewer();
  const [entries, setEntries] = useState<AdminAuditEntry[] | null>(null);
  useEffect(() => void dataSource.admin!.support.audit(viewer.id, 50).then(setEntries), [viewer.id]);
  return (
    <section className="admin-card" aria-label="Audit log">
      <AuditList entries={entries} />
    </section>
  );
}
