import { z } from "zod";
import { ACCESS_LABELS } from "../access/policy";

// Document metadata lives in a small YAML-style header: `key: value` lines between two `---` fences.

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

export const docMetaSchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "expected kebab-case"),
  title: z.string().min(3),
  /** Owning department, free text (used in "who to ask"). */
  department: z.string().min(2),
  access: z.enum(ACCESS_LABELS),
  owner: z.string().min(3),
  owner_role: z.string().min(3),
  version: z.coerce.number().int().min(1),
  effective_date: isoDate,
  /** Id of the older document this one replaces, or null. */
  supersedes: z.string().nullable(),
  language: z.enum(["pl", "en"]),
});
export type DocMeta = z.infer<typeof docMetaSchema>;

export interface ParsedDoc {
  meta: DocMeta;
  body: string;
}

export function parseDocument(raw: string): ParsedDoc {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!match) throw new Error("missing front matter (--- fences)");
  const fields: Record<string, string | null> = {};
  for (const line of (match[1] ?? "").split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const idx = line.indexOf(":");
    if (idx < 1) throw new Error(`bad front matter line: ${line}`);
    const value = line.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
    fields[line.slice(0, idx).trim()] = value === "" || value === "null" ? null : value;
  }
  const parsed = docMetaSchema.safeParse(fields);
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  }
  return { meta: parsed.data, body: (match[2] ?? "").trim() };
}
