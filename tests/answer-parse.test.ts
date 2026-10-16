import { describe, expect, it } from "vitest";
import { parseBlocks, parseInline } from "../src/web/answerParse";

describe("answer rendering structure", () => {
  it("splits text, bold and citation markers", () => {
    expect(parseInline("Masz **20 dni** urlopu [1][2].")).toEqual([
      { kind: "text", text: "Masz " },
      { kind: "bold", text: "20 dni" },
      { kind: "text", text: " urlopu " },
      { kind: "cite", n: 1 },
      { kind: "cite", n: 2 },
      { kind: "text", text: "." },
    ]);
  });

  it("does not treat other brackets, an unclosed bold or a long number as markup", () => {
    expect(parseInline("[abc] **nie zamknięte [123]")).toEqual([{ kind: "text", text: "[abc] **nie zamknięte [123]" }]);
    expect(parseInline("")).toEqual([]);
  });

  it("builds paragraphs, bullet lists and numbered lists", () => {
    const blocks = parseBlocks("Wstęp [1]\nDruga linia\n\n- jeden [2]\n- dwa\n\n1. krok\n2) drugi krok\n\nKoniec");
    expect(blocks.map((b) => b.kind)).toEqual(["p", "ul", "ol", "p"]);
    expect(blocks[0]).toMatchObject({ kind: "p", lines: [[{ kind: "text", text: "Wstęp " }, { kind: "cite", n: 1 }], [{ kind: "text", text: "Druga linia" }]] });
    expect((blocks[1] as { items: unknown[] }).items).toHaveLength(2);
    expect((blocks[2] as { items: unknown[] }).items).toHaveLength(2);
  });

  it("a list that follows an intro line without a blank line is still a list", () => {
    const blocks = parseBlocks("Warto wiedzieć:\n- jeden [1]\n- dwa\nPodsumowanie.");
    expect(blocks.map((b) => b.kind)).toEqual(["p", "ul", "p"]);
    expect((blocks[1] as { items: unknown[] }).items).toHaveLength(2);
  });

  it("switches between list kinds, and empty input gives no blocks", () => {
    expect(parseBlocks("- a\n1. b").map((b) => b.kind)).toEqual(["ul", "ol"]);
    expect(parseBlocks("   \n\n  ")).toEqual([]);
  });

  it("keeps markup-like text as text (the UI renders text nodes, never HTML)", () => {
    const [b] = parseBlocks("<script>alert(1)</script> [1]");
    expect(JSON.stringify(b)).toContain("<script>alert(1)</script>");
    expect(b).toMatchObject({ kind: "p" });
  });
});
