import type { ReactNode } from "react";
import type { Source } from "./api";
import { parseBlocks, type Inline } from "./answerParse";

function InlineText({ parts, sources }: { parts: Inline[]; sources: Source[] }) {
  return (
    <>
      {parts.map((p, i): ReactNode => {
        if (p.kind === "bold") return <strong key={i}>{p.text}</strong>;
        if (p.kind === "cite") {
          const s = sources.find((x) => x.n === p.n);
          // A marker with no matching source is shown as plain text, never as a link.
          if (!s) return <span key={i}>[{p.n}]</span>;
          return (
            <a key={i} className="cite" href={s.url} target="_blank" rel="noopener" title={`${s.title}: ${s.section}`} aria-label={`Source ${p.n}: ${s.title}, ${s.section}`}>
              {p.n}
            </a>
          );
        }
        return <span key={i}>{p.text}</span>;
      })}
    </>
  );
}

export function Answer({ text, sources }: { text: string; sources: Source[] }) {
  return (
    <div className="answer-text">
      {parseBlocks(text).map((b, i) => {
        if (b.kind === "ul" || b.kind === "ol") {
          const List = b.kind;
          return (
            <List key={i}>
              {b.items.map((item, j) => (
                <li key={j}>
                  <InlineText parts={item} sources={sources} />
                </li>
              ))}
            </List>
          );
        }
        return (
          <p key={i}>
            {b.lines.map((line, j) => (
              <span key={j}>
                {j > 0 && <br />}
                <InlineText parts={line} sources={sources} />
              </span>
            ))}
          </p>
        );
      })}
    </div>
  );
}
