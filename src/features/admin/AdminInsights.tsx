import { useEffect, useState } from "react";
import { Link } from "react-router";
import { dataSource, type PlatformInsights } from "../../data";
import { timeAgo } from "../../lib/time";
import { Avatar } from "../../ui/Avatar";
import { Button } from "../../ui/Button";

const fmt = (n: number) => n.toLocaleString();

/**
 * Admin → Overview: platform metrics counted on the server (admin_insights),
 * a 14-day trend and the newest accounts. Never message content, emails or
 * per-person browsing.
 */
export function AdminInsights({ fallback }: { fallback: React.ReactNode }) {
  const api = dataSource.admin!.moderation!;
  const [data, setData] = useState<PlatformInsights | null | "error">(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    api.insights!().then(
      (d) => live && setData(d),
      () => live && setData("error"),
    );
    return () => {
      live = false;
    };
  }, [api, tick]);

  // An older database without admin_insights: keep the previous card.
  if (data === "error") return <>{fallback}</>;
  if (!data) {
    return (
      <section className="admin-card" aria-busy="true">
        <h2 className="admin-card__title">Platform</h2>
        <p className="admin-muted">Loading…</p>
      </section>
    );
  }

  const groups: { title: string; items: [string, number, string?][] }[] = [
    {
      title: "People",
      items: [
        ["Accounts", data.users],
        ["Verified emails", data.usersVerifiedEmail],
        ["New today", data.newUsersToday, "Since midnight UTC"],
        ["New in 7 days", data.newUsers7d],
        ["Active, 24 h (DAU)", data.dau],
        ["Active, 7 days (WAU)", data.wau],
        ["Active, 30 days (MAU)", data.mau],
      ],
    },
    {
      title: "Content",
      items: [
        ["Posts", data.posts],
        ["Replies", data.replies],
        ["Posts in 7 days", data.posts7d],
        ["Moments live now", data.momentsLive],
        ["Moments in 7 days", data.moments7d],
      ],
    },
    {
      title: "Worlds & Support Hub",
      items: [
        ["Worlds", data.worlds],
        ["Worlds live", data.worldsLive],
        ["Worlds upcoming", data.worldsUpcoming],
        ["Support requests", data.supportRequests],
        ["Support requests open", data.supportOpen],
      ],
    },
    {
      title: "Safety",
      items: [
        ["Open reports", data.reportsOpen],
        ["Admin actions, 7 days", data.moderationActions7d],
        ["Suspended", data.suspended],
        ["Admins", data.admins],
      ],
    },
  ];

  return (
    <>
      <section className="admin-card" aria-labelledby="ins-title">
        <div className="admin-card__head">
          <h2 id="ins-title" className="admin-card__title">Platform</h2>
          <Button size="sm" variant="ghost" onClick={() => setTick((t) => t + 1)}>
            Refresh
          </Button>
        </div>
        {groups.map((g) => (
          <div key={g.title}>
            <h3 className="admin-subtitle">{g.title}</h3>
            <dl className="admin-stats">
              {g.items.map(([label, n, hint]) => (
                <div key={label} className="admin-stats__item" title={hint}>
                  <dt>{label}</dt>
                  <dd>{fmt(n)}</dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
        <p className="admin-muted">
          "Active" counts signed-in people who did something that leaves a record — posted or replied, liked, followed, sent a message, posted,
          viewed or reacted to a Moment, joined a World or opened a Support request. Reading alone leaves no record, so these are lower bounds.
          Message counts never include content. Updated {timeAgo(data.generatedAt)}.
        </p>
      </section>

      <section className="admin-card" aria-labelledby="ins-trend">
        <h2 id="ins-trend" className="admin-card__title">Last 14 days</h2>
        <div className="admin-charts">
          <DailyBars title="Active people" days={data.daily} pick={(d) => d.active} />
          <DailyBars title="New accounts" days={data.daily} pick={(d) => d.signups} />
          <DailyBars title="New posts" days={data.daily} pick={(d) => d.posts} />
        </div>
        <details className="admin-table-toggle">
          <summary>Show as a table</summary>
          <table className="admin-table">
            <thead>
              <tr>
                <th scope="col">Day (UTC)</th>
                <th scope="col">Active</th>
                <th scope="col">New accounts</th>
                <th scope="col">New posts</th>
              </tr>
            </thead>
            <tbody>
              {data.daily.map((d) => (
                <tr key={d.day}>
                  <th scope="row">{d.day}</th>
                  <td>{d.active}</td>
                  <td>{d.signups}</td>
                  <td>{d.posts}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      </section>

      <section className="admin-card" aria-labelledby="ins-recent">
        <h2 id="ins-recent" className="admin-card__title">Newest accounts</h2>
        {data.recentUsers.length === 0 ? (
          <p className="admin-muted">No accounts yet.</p>
        ) : (
          <ul className="admin-rows">
            {data.recentUsers.map((u) => (
              <li key={u.id} className="admin-row admin-row--person">
                <Avatar name={u.name} src={u.avatarUrl} seed={u.id} size="sm" />
                <div className="admin-row__main">
                  <Link to={`/admin/users?u=${encodeURIComponent(u.handle)}`} className="admin-row__title">
                    {u.name}
                  </Link>
                  <span className="admin-muted">
                    @{u.handle} · joined {timeAgo(u.joinedAt)}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

type Day = PlatformInsights["daily"][number];

/** One measure per chart (no shared or second axis); hover or focus a bar for its value. */
function DailyBars({ title, days, pick }: { title: string; days: Day[]; pick: (d: Day) => number }) {
  const values = days.map(pick);
  const max = Math.max(1, ...values);
  const total = values.reduce((a, b) => a + b, 0);
  const [hover, setHover] = useState<number | null>(null);
  const shown = hover ?? values.length - 1;
  const label = (i: number) => new Date(`${days[i].day}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
  return (
    <figure className="admin-chart">
      <figcaption className="admin-chart__head">
        <span>{title}</span>
        <span className="admin-chart__value">
          {days.length ? (
            <>
              <strong>{fmt(values[shown])}</strong> <span className="admin-muted">{hover === null ? "today" : label(shown)}</span>
            </>
          ) : null}
        </span>
      </figcaption>
      <div className="admin-chart__bars" role="list" aria-label={`${title}, last 14 days, ${fmt(total)} in total`} onMouseLeave={() => setHover(null)}>
        {values.map((v, i) => (
          <div
            key={days[i].day}
            role="listitem"
            tabIndex={0}
            className={`admin-chart__slot${hover === i ? " is-active" : ""}`}
            aria-label={`${label(i)}: ${v}`}
            onMouseEnter={() => setHover(i)}
            onFocus={() => setHover(i)}
            onBlur={() => setHover(null)}
          >
            <span className="admin-chart__bar" style={{ height: v ? `${Math.max(4, (v / max) * 100)}%` : 0 }} />
          </div>
        ))}
      </div>
      <div className="admin-chart__axis admin-muted" aria-hidden="true">
        <span>{days.length ? label(0) : ""}</span>
        <span>max {fmt(max === 1 && !values.some(Boolean) ? 0 : max)}</span>
        <span>{days.length ? label(days.length - 1) : ""}</span>
      </div>
    </figure>
  );
}
