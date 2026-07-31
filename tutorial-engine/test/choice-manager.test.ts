import { describe, expect, it } from "vitest";
import { ChoiceManager } from "../src/agent/choice-manager.js";

describe("ChoiceManager", () => {
  it("only resolves declared options", async () => {
    const choices = new ChoiceManager();
    const pending = choices.wait("step", [{ id: "learner", label: "I will do it", icon: "do" }, { id: "coach", label: "Show me", icon: "show" }]);
    expect(choices.choose("step", "other")).toBe(false);
    expect(choices.choose("step", "coach")).toBe(true);
    await expect(pending).resolves.toBe("coach");
  });

  it("cancels pending selections", async () => {
    const choices = new ChoiceManager();
    const pending = choices.wait("step", [{ id: "a", label: "A", icon: "do" }, { id: "b", label: "B", icon: "pause" }]);
    choices.cancelAll();
    await expect(pending).rejects.toThrow("cancelled");
  });
});
