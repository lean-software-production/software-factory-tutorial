import { describe, expect, it } from "vitest";
import { correctFactory } from "../scenarios/lesson-001/scenarios.js";
import { runFactoryWithStubs } from "../harness/factory-stubs.js";
import { lesson002Scenarios } from "../scenarios/lesson-002/scenarios.js";

describe("factory stubs", () => {
  it("observes the exact isolated Pi turn and learner pause without a model", async () => {
    const result = await runFactoryWithStubs(correctFactory);
    const pi = result.invocations.find((entry) => entry.command === "pi");
    expect(result.syntaxPassed).toBe(true);
    expect(result.paused).toBe(true);
    expect(result.output).toContain("Starting refactoring iteration...");
    expect(pi).toMatchObject({ args: ["--no-session", "--tools", "read,edit,write,grep,find,ls", "-p"] });
    expect(pi?.cwd).toMatch(/calculator$/);
    expect(pi?.stdin).toContain("refactor prompt");
  });

  it("routes failed validation evidence to the recovery worker on the next turn", async () => {
    const factory = lesson002Scenarios[0]?.patches[1]?.files["factory/factory.sh"];
    expect(factory).toBeDefined();
    const result = await runFactoryWithStubs(factory!, ["fail", "pass"]);
    const turns = result.invocations.filter((entry) => entry.command === "pi");
    expect(turns).toHaveLength(2);
    expect(turns[0]?.stdin).toContain("refactor prompt");
    expect(turns[1]?.stdin).toContain("fix prompt");
    expect(turns[1]?.stdin).toContain("intentional failure");
    expect(result.failureLogBeforeEnter).toContain("intentional failure");
  });

  it("clears a failure log after independent passing validation", async () => {
    const factory = lesson002Scenarios[0]?.patches[1]?.files["factory/factory.sh"];
    const result = await runFactoryWithStubs(factory!, ["pass"]);
    expect(result.invocations.some((entry) => entry.command === "npm")).toBe(true);
    expect(result.failureLogBeforeEnter).toBeUndefined();
  });
});
