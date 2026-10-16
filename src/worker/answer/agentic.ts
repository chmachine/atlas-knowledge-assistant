import { AGENT_MAX_STEPS, MAX_OUTPUT_TOKENS } from "../../config";
import type { ChunkRow } from "../retrieval/store";
import type { JsonBlock, Llm, LlmMessage, LlmResponse } from "./llm";
import { AGENTIC_ADDENDUM, CONTACTS_DOC_ID, SYSTEM_PROMPT } from "./prompts";
import { RunError, addUsage, emptyUsage, type ModelRun, type ToolCallLog } from "./run";
import { TOOL_DEFS, runTool } from "./tools";

const clip = (input: unknown): unknown => {
  const s = JSON.stringify(input ?? null);
  return s.length <= 400 ? input : `${s.slice(0, 400)}…`;
};

/**
 * Agentic mode: the model drives its own search with list_documents, search_text and read_section, for at most AGENT_MAX_STEPS model calls.
 * The question must already be redacted. Every tool runs with the role from the session.
 *
 * Mechanics worth knowing:
 *  - Each assistant turn is appended exactly as returned (thinking blocks included), and all tool results for a turn go back in ONE user message.
 *  - Citations point at search_result blocks counted in request order across the whole conversation, so `given` records every chunk in the
 *    order its block was added. The same chunk returned twice has two entries; parseAnswer merges them.
 *  - An exact repeat of an earlier call is answered with a note instead of new blocks.
 *  - The last allowed step is sent with tool_choice "none", so the model has to answer with what it has.
 */
export async function runAgentic(deps: { db: D1Database; llm: Llm }, role: string, question: string): Promise<ModelRun> {
  const system = SYSTEM_PROMPT + AGENTIC_ADDENDUM;
  const messages: LlmMessage[] = [{ role: "user", content: [{ type: "text", text: question }] }];
  const given: ChunkRow[] = [];
  const toolCalls: ToolCallLog[] = [];
  const signatures = new Set<string>();
  let usage = emptyUsage();
  let model = "";
  let fellBack = false;
  let redactions = 0;
  let last: LlmResponse | undefined;

  const relevant = () => [...new Set(given.filter((c) => c.doc_id !== CONTACTS_DOC_ID).map((c) => c.id))];
  const finish = (res: LlmResponse, stopReason: string | null, steps: number): ModelRun => ({
    content: res.content, stopReason, usage, model, fellBack, given, relevantIds: relevant(), toolCalls, redactions, steps,
  });

  for (let step = 1; step <= AGENT_MAX_STEPS; step++) {
    try {
      last = await deps.llm.create({
        system,
        messages,
        tools: TOOL_DEFS,
        maxTokens: MAX_OUTPUT_TOKENS,
        effort: "medium",
        ...(step === AGENT_MAX_STEPS ? { toolChoice: "none" as const } : {}),
      });
    } catch (e) {
      throw new RunError("model", (e as Error).message, relevant());
    }
    usage = addUsage(usage, last.usage);
    model = last.model;
    fellBack ||= last.fellBack;

    const uses = last.content.filter((b): b is JsonBlock & { id: string; name: string } => b.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string");
    if (last.stopReason !== "tool_use" || uses.length === 0) return finish(last, last.stopReason, step);

    messages.push({ role: "assistant", content: last.content });
    const results: JsonBlock[] = [];
    for (const use of uses) {
      // What the model typed into a tool stays as typed for the query itself (it only reads the local database). It is redacted where it
      // leaves: when the call is written to the audit log and when it is shown to the user (see ask.ts).
      const toolInput = use.input;
      const signature = `${use.name}:${JSON.stringify(toolInput ?? null)}`;
      let outcome;
      if (signatures.has(signature)) {
        outcome = { content: "You already made this exact call. Use its earlier result instead of repeating it.", chunks: [] as ChunkRow[], isError: false, found: 0, redactions: 0 };
      } else {
        signatures.add(signature);
        try {
          outcome = await runTool({ db: deps.db, role }, use.name, toolInput);
        } catch (e) {
          outcome = { content: "The tool failed. Try a different approach.", chunks: [] as ChunkRow[], isError: true, found: 0, redactions: 0 };
          toolCalls.push({ step, tool: use.name, input: clip(toolInput), found: 0, chunkIds: [], error: (e as Error).message.slice(0, 200) });
          results.push({ type: "tool_result", tool_use_id: use.id, content: outcome.content, is_error: true });
          continue;
        }
      }
      given.push(...outcome.chunks);
      redactions += outcome.redactions;
      toolCalls.push({ step, tool: use.name, input: clip(toolInput), found: outcome.found, chunkIds: outcome.chunks.map((c) => c.id), ...(outcome.isError ? { error: String(outcome.content).slice(0, 200) } : {}) });
      results.push({ type: "tool_result", tool_use_id: use.id, content: outcome.content, ...(outcome.isError ? { is_error: true } : {}) });
    }
    messages.push({ role: "user", content: results });
  }

  // Only reached when even the final, tool-less step asked for a tool.
  return finish(last!, "max_steps", AGENT_MAX_STEPS);
}
