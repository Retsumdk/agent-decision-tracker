import { describe, test, expect } from "bun:test";
describe("agent-decision-tracker", () => {
  test("module loads", async () => { const m = await import("../src/index.js"); expect(m).toBeDefined(); });
});
