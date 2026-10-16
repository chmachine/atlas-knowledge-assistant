import { z } from "zod";
import { getDocTitles, getDocumentChunks, listDocuments, readSection, searchChunks, type ChunkRow } from "../retrieval/store";
import type { JsonBlock, LlmTool } from "./llm";
import { buildSearchResults } from "./prompts";

// The agent's three tools. Each one is a thin wrapper over a role-enforced function in retrieval/store.ts, and the role comes from
// the session through ToolContext, never from the model's input: a `role` field in the input is stripped by the schema and ignored.

export const TOOL_DEFS: LlmTool[] = [
  {
    name: "list_documents",
    description:
      "List the documents available to the current user: id, title, department, owner, version, effective date and whether it is the CURRENT or an OUTDATED version. Optionally filter by department (for example HR, IT, Finanse). Use it to see what exists or to find which document owns a topic. It returns no document text.",
    input_schema: {
      type: "object",
      properties: { department: { type: "string", description: "Optional department name, for example HR or Finanse." } },
      additionalProperties: false,
    },
  },
  {
    name: "search_text",
    description:
      "Keyword search over the text of the documents available to the current user. Matching is by parts of words, so a word stem finds its forms ('urlop' finds 'urlopu' and 'urlopowy'). Write Polish words with their Polish letters. Returns the best matching passages, which you can cite. Use several short queries rather than one long sentence, and try Polish and English words.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "One or two key terms." },
        limit: { type: "integer", minimum: 1, maximum: 8, description: "How many passages to return (default 5)." },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "read_section",
    description:
      "Read one full section of a document the current user may read. doc_id is the document id (shown in the SOURCE INFO line of a search result, and by list_documents); section is the section name, for example 'Wymiar urlopu wypoczynkowego'. Returns the passage so you can cite it.",
    input_schema: {
      type: "object",
      properties: {
        doc_id: { type: "string", description: "The document id." },
        section: { type: "string", description: "The section name or a part of it." },
      },
      required: ["doc_id", "section"],
      additionalProperties: false,
    },
  },
];

const listArgs = z.object({ department: z.string().max(60).optional() });
const searchArgs = z.object({ query: z.string().min(1).max(200), limit: z.number().int().min(1).max(8).optional() });
const readArgs = z.object({ doc_id: z.string().min(1).max(80), section: z.string().min(1).max(120) });

export interface ToolContext {
  db: D1Database;
  /** From the server-side session. */
  role: string;
}

export interface ToolOutcome {
  /** Plain text, or search_result blocks (a tool_result may hold one kind or the other, not both). */
  content: string | JsonBlock[];
  /** The chunks returned as search_result blocks, in order. */
  chunks: ChunkRow[];
  isError: boolean;
  /** Passages or documents returned. */
  found: number;
  redactions: number;
}

const text = (content: string, isError = false): ToolOutcome => ({ content, chunks: [], isError, found: 0, redactions: 0 });

async function asResults(ctx: ToolContext, chunks: ChunkRow[]): Promise<ToolOutcome> {
  const referenced = chunks.flatMap((c) => [c.supersedes, c.superseded_by].filter((x): x is string => Boolean(x)));
  const titles = await getDocTitles(ctx.db, ctx.role, referenced);
  const { blocks, redactions } = buildSearchResults(chunks, (id) => titles.get(id));
  return { content: blocks, chunks, isError: false, found: chunks.length, redactions: Object.values(redactions).reduce((a, b) => a + b, 0) };
}

export async function runTool(ctx: ToolContext, name: string, input: unknown): Promise<ToolOutcome> {
  switch (name) {
    case "list_documents": {
      const args = listArgs.safeParse(input ?? {});
      if (!args.success) return text("Invalid input for list_documents: department must be a short text.", true);
      const docs = await listDocuments(ctx.db, ctx.role, { department: args.data.department });
      if (!docs.length) return text("No documents match.");
      const lines = docs.map((d) =>
        JSON.stringify({ id: d.id, title: d.title, department: d.department, owner: `${d.owner_name}, ${d.owner_role}`, version: d.version, effective: d.effective_date, status: d.is_latest ? "CURRENT" : `OUTDATED (superseded by ${d.superseded_by})` }),
      );
      return { content: lines.join("\n"), chunks: [], isError: false, found: docs.length, redactions: 0 };
    }

    case "search_text": {
      const args = searchArgs.safeParse(input);
      if (!args.success) return text("Invalid input for search_text: query must be a short text (1-200 characters) and limit a whole number from 1 to 8.", true);
      const hits = await searchChunks(ctx.db, ctx.role, args.data.query, args.data.limit ?? 5);
      if (!hits.length) return text("No passages matched. Try other words (a shorter stem, a Polish or English synonym) or call list_documents.");
      return asResults(ctx, hits);
    }

    case "read_section": {
      const args = readArgs.safeParse(input);
      if (!args.success) return text("Invalid input for read_section: doc_id and section must both be short texts.", true);
      const chunks = await readSection(ctx.db, ctx.role, args.data.doc_id, args.data.section);
      if (chunks) return asResults(ctx, chunks);
      // A document the user may read but with no such section: list the sections. A document the user may not read, or one that does
      // not exist, gets the same generic answer, so the existence of a restricted document is not revealed.
      const doc = await getDocumentChunks(ctx.db, ctx.role, args.data.doc_id);
      if (doc) return text(`No such section. Sections of this document: ${[...new Set(doc.map((c) => c.section_path))].join("; ")}`);
      return text("No such document or section is available to you.");
    }

    default:
      return text(`Unknown tool "${name.slice(0, 40)}". Available tools: list_documents, search_text, read_section.`, true);
  }
}
