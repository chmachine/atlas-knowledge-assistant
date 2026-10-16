// Turns the assistant's answer text into a small structure the UI renders. Pure and DOM-free so it can be unit tested.
// Supported: paragraphs, "- " and "1. " lists, **bold**, and citation markers like [2]. Everything else is plain text.

export type Inline = { kind: "text"; text: string } | { kind: "bold"; text: string } | { kind: "cite"; n: number };
export type Block = { kind: "p"; lines: Inline[][] } | { kind: "ul"; items: Inline[][] } | { kind: "ol"; items: Inline[][] };

export function parseInline(s: string): Inline[] {
  const out: Inline[] = [];
  for (const part of s.split(/(\*\*[^*\n]+\*\*|\[\d{1,2}\])/g)) {
    if (!part) continue;
    const bold = /^\*\*(.+)\*\*$/.exec(part);
    const cite = /^\[(\d{1,2})\]$/.exec(part);
    if (bold) out.push({ kind: "bold", text: bold[1]! });
    else if (cite) out.push({ kind: "cite", n: Number(cite[1]) });
    else out.push({ kind: "text", text: part });
  }
  return out;
}

const UL = /^\s*[-*•]\s+(.*)$/;
const OL = /^\s*\d{1,2}[.)]\s+(.*)$/;

export function parseBlocks(text: string): Block[] {
  type Run = { kind: "p" | "ul" | "ol"; rows: Inline[][] };
  const runs: Run[] = [];
  for (const raw of text.trim().split(/\n\s*\n/)) {
    // Within one block, consecutive list lines become a list and consecutive other lines a paragraph,
    // so "Intro:\n- a\n- b" gives a paragraph followed by a list (models often write it without a blank line).
    let last: Run | undefined;
    for (const line of raw.split("\n").filter((l) => l.trim() !== "")) {
      const ul = UL.exec(line);
      const ol = ul ? null : OL.exec(line);
      const kind = ul ? "ul" : ol ? "ol" : "p";
      if (!last || last.kind !== kind) {
        last = { kind, rows: [] };
        runs.push(last);
      }
      last.rows.push(parseInline(ul ? ul[1]! : ol ? ol[1]! : line.trim()));
    }
  }
  return runs.map((r): Block => (r.kind === "p" ? { kind: "p", lines: r.rows } : { kind: r.kind, items: r.rows }));
}
