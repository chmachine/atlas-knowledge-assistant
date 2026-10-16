import { describe, expect, it } from "vitest";
import { costTotalNote } from "../src/web/dashboardText";

describe("the cost line on the dashboard", () => {
  it("is just the total when nothing in view is simulated", () => {
    expect(costTotalNote(1.234, 0)).toBe("$1.23 in total");
    expect(costTotalNote(0, 0)).toBe("$0.00 in total");
  });

  it("says that simulated questions are included, modelled and not billed, as soon as one is in view", () => {
    for (const n of [1, 313]) expect(costTotalNote(5.36, n)).toBe("$5.36 in total, including simulated questions (modelled, not billed)");
  });
});
