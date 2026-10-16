import { redactText } from "../governance/redact";
import type { ChunkRow } from "../retrieval/store";
import type { JsonBlock } from "./llm";
import { NO_ANSWER_MARKER, sourceUrl } from "./prompts";

export interface SourceRef {
  /** Marker number shown in the answer: [n]. */
  n: number;
  chunkId: string;
  docId: string;
  anchor: string;
  title: string;
  section: string;
  /** Link to the source text: /source/<doc>#<section>. */
  url: string;
  ownerName: string;
  ownerRole: string;
  isLatest: boolean;
  injectionFlag: boolean;
  /** Short redacted excerpt of the cited chunk, taken from our own database, not from the model. */
  snippet: string;
}

export interface ParsedAnswer {
  /** Answer text with [n] markers after each cited passage. The no-answer marker is removed. */
  text: string;
  sources: SourceRef[];
  noAnswer: boolean;
  /** Citations the API returned that did not match a source we gave it. They are ignored. */
  droppedCitations: number;
}

const SNIPPET_CHARS = 240;

/**
 * Turns the model's content blocks into text plus verified citations.
 * `given` are the chunks that were sent as search_result blocks, in order. A citation counts only if its index points at one of them
 * and its source link matches that chunk, so the model cannot cite something it was not shown.
 */
export function parseAnswer(content: JsonBlock[], given: ChunkRow[]): ParsedAnswer {
  const sources: SourceRef[] = [];
  const numberOf = new Map<string, number>();
  let dropped = 0;
  let text = "";

  for (const block of content) {
    if (block.type !== "text") continue;
    const marks: number[] = [];
    for (const raw of Array.isArray(block.citations) ? (block.citations as unknown[]) : []) {
      const cit = raw as { type?: string; search_result_index?: unknown; source?: unknown };
      if (cit.type !== "search_result_location") {
        dropped++;
        continue;
      }
      const chunk = typeof cit.search_result_index === "number" ? given[cit.search_result_index] : undefined;
      if (!chunk || cit.source !== sourceUrl(chunk)) {
        dropped++;
        continue;
      }
      let n = numberOf.get(chunk.id);
      if (n === undefined) {
        n = sources.length + 1;
        numberOf.set(chunk.id, n);
        sources.push({
          n,
          chunkId: chunk.id,
          docId: chunk.doc_id,
          anchor: chunk.anchor,
          title: chunk.title,
          section: chunk.section_path,
          url: sourceUrl(chunk),
          ownerName: chunk.owner_name,
          ownerRole: chunk.owner_role,
          isLatest: chunk.is_latest,
          injectionFlag: chunk.injection_flag,
          snippet: redactText(chunk.text).slice(0, SNIPPET_CHARS),
        });
      }
      if (!marks.includes(n)) marks.push(n);
    }
    text += String(block.text ?? "") + marks.map((n) => ` [${n}]`).join("");
  }

  const trimmed = text.trim();
  const noAnswer = trimmed.startsWith(NO_ANSWER_MARKER);
  return { text: noAnswer ? trimmed.slice(NO_ANSWER_MARKER.length).trim() : trimmed, sources, noAnswer, droppedCitations: dropped };
}
