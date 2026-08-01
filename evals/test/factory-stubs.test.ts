import { describe, expect, it } from "vitest";
import { correctRun } from "../scenarios/lesson-001/scenarios.js";
import { correctReviewRun } from "../scenarios/lesson-002/scenarios.js";
import { correctLoopRun } from "../scenarios/lesson-003/scenarios.js";
import { correctRoutingRun } from "../scenarios/lesson-004/scenarios.js";
import { runFactoryWithStubs } from "../harness/factory-stubs.js";

describe("factory stubs", () => {
  it("observes the lesson 001 one-shot isolated doer without a model", async () => {
    const result = await runFactoryWithStubs(correctRun);
    const turns = result.invocations.filter((entry) => entry.command === "pi");
    expect(result.syntaxPassed).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Starting doer...");
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ args: ["--no-session", "--tools", "read,edit,write,grep,find,ls", "-p"] });
    expect(turns[0]?.cwd).toMatch(/calculator$/);
    expect(turns[0]?.stdin).toContain("refactor prompt");
  });

  it("observes the lesson 002 reviewer as a separate read-and-bash turn", async () => {
    const result = await runFactoryWithStubs(correctReviewRun);
    const turns = result.invocations.filter((entry) => entry.command === "pi");
    expect(result.syntaxPassed).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Starting doer...");
    expect(result.output).toContain("Starting review...");
    expect(turns).toHaveLength(2);
    expect(turns[0]?.args).toEqual(["--no-session", "--tools", "read,edit,write,grep,find,ls", "-p"]);
    expect(turns[1]?.args).toEqual(["--no-session", "--tools", "read,grep,find,ls,bash", "-p"]);
    expect(turns[1]?.stdin).toContain("review prompt");
    expect(turns[1]?.stdin).toContain("success prompt");
  });

  it("observes the lesson 003 loop pause after doer and reviewer", async () => {
    const result = await runFactoryWithStubs(correctLoopRun);
    const turns = result.invocations.filter((entry) => entry.command === "pi");
    expect(result.syntaxPassed).toBe(true);
    expect(result.paused).toBe(true);
    expect(result.output).toContain("Starting doer iteration...");
    expect(result.output).toContain("Starting review...");
    expect(turns[0]?.stdin).toContain("refactor prompt");
    expect(turns[1]?.stdin).toContain("review prompt");
  });

  it("routes a failed saved review to repair on the next lesson 004 turn", async () => {
    const result = await runFactoryWithStubs(correctRoutingRun, [
      "VERDICT: FAIL\n\nFINDINGS:\n- [FAIL] passes tests: intentional failure\n",
      "VERDICT: PASS\n\nFINDINGS:\n- [PASS] passes tests: repaired\n"
    ]);
    const turns = result.invocations.filter((entry) => entry.command === "pi");
    expect(result.syntaxPassed).toBe(true);
    expect(result.paused).toBe(true);
    expect(result.reviewReportBeforeEnter).toContain("VERDICT: FAIL");
    expect(turns[0]?.stdin).toContain("refactor prompt");
    expect(turns.some((entry) => entry.stdin.includes("repair prompt"))).toBe(true);
    expect(result.output).toContain("Starting repair iteration...");
  });
});
