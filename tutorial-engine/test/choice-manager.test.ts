import { describe, expect, it } from "vitest";
import { ChoiceManager } from "../src/agent/choice-manager.js";

describe("ChoiceManager", () => {
  it("only resolves declared options", async () => {
    const choices = new ChoiceManager();
    const pending = choices.wait("step", [{ id: "learner", label: "I will do it" }, { id: "coach", label: "Show me" }]);
    expect(choices.choose("step", "other")).toBe(false);
    expect(choices.choose("step", "coach")).toBe(true);
    await expect(pending).resolves.toBe("coach");
  });

  it("cancels pending selections", async () => {
    const choices = new ChoiceManager();
    const pending = choices.wait("step", [{ id: "a", label: "A" }, { id: "b", label: "B" }]);
    choices.cancelAll();
    await expect(pending).rejects.toThrow("cancelled");
  });
});
