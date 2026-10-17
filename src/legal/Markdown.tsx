import { Fragment, type ReactNode } from "react";
import { Link } from "react-router";

/**
 * Renders the small Markdown subset used by the legal documents (headings,
 * paragraphs, lists, tables, quotes, **bold**, [links](…)) as React elements —
 * no HTML injection.
 */
export function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r/g, "").split("\n");
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1].length;
      const content = inline(h[2]);
      blocks.push(level === 1 ? <h1 key={key++}>{content}</h1> : level === 2 ? <h2 key={key++}>{content}</h2> : <h3 key={key++}>{content}</h3>);
      i++;
      continue;
    }
    if (line.startsWith(">")) {
      const quote: string[] = [];
      while (i < lines.length && lines[i].startsWith(">")) quote.push(lines[i++].replace(/^>\s?/, ""));
      blocks.push(<blockquote key={key++}>{inline(quote.join(" "))}</blockquote>);
      continue;
    }
    if (/^\s*[-*]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items: string[] = [];
      while (i < lines.length && (ordered ? /^\s*\d+\.\s+/ : /^\s*[-*]\s+/).test(lines[i])) items.push(lines[i++].replace(/^\s*(?:[-*]|\d+\.)\s+/, ""));
      const children = items.map((t, n) => <li key={n}>{inline(t)}</li>);
      blocks.push(ordered ? <ol key={key++}>{children}</ol> : <ul key={key++}>{children}</ul>);
      continue;
    }
    if (line.startsWith("|")) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i].startsWith("|")) {
        const cells = lines[i++].split("|").slice(1, -1).map((c) => c.trim());
        if (!cells.every((c) => /^-+$/.test(c))) rows.push(cells);
      }
      const [head, ...body] = rows;
      blocks.push(
        <div className="md-table" key={key++}>
          <table>
            <thead>
              <tr>{head.map((c, n) => <th key={n}>{inline(c)}</th>)}</tr>
            </thead>
            <tbody>
              {body.map((r, n) => (
                <tr key={n}>{r.map((c, m) => <td key={m}>{inline(c)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,3}\s|>|\||\s*[-*]\s|\s*\d+\.\s)/.test(lines[i])) para.push(lines[i++]);
    blocks.push(<p key={key++}>{inline(para.join(" "))}</p>);
  }
  return <>{blocks}</>;
}

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\*\*(.+?)\*\*|\[([^\]]+)\]\(([^)]+)\)/g;
  let last = 0;
  let n = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push(<Fragment key={n++}>{text.slice(last, m.index)}</Fragment>);
    if (m[1] !== undefined) out.push(<strong key={n++}>{m[1]}</strong>);
    else {
      const href = m[3];
      out.push(
        href.startsWith("/") ? (
          <Link key={n++} to={href}>{m[2]}</Link>
        ) : /^https:\/\//.test(href) ? (
          <a key={n++} href={href} target="_blank" rel="noreferrer noopener">{m[2]}</a>
        ) : (
          <Fragment key={n++}>{m[2]}</Fragment>
        ),
      );
    }
    last = re.lastIndex;
  }
  if (last < text.length) out.push(<Fragment key={n++}>{text.slice(last)}</Fragment>);
  return out;
}
