import { describe, expect, it } from "vitest";
import { parseV2EvalArgs, prepareV2EvalCliRun, selectV2Scenarios, v2EvalUsageText, v2ReleaseScenarioIds } from "../run.js";
import { v2Scenarios } from "../v2/scenarios.js";

describe("v2 eval runner CLI parsing", () => {
  it("keeps help and argument errors ahead of model preflight", () => {
    const help = v2EvalUsageText();
    expect(help).toContain("npm run eval -- --release");
    expect(help).toContain("npm run eval:release");

    expect(() => prepareV2EvalCliRun(["--all"], {})).toThrow("--all can spend model tokens across 6 live scenarios");
    expect(() => prepareV2EvalCliRun(["--release", "--repeat", "2"], {})).toThrow("--release always runs each scenario once");
    expect(() => prepareV2EvalCliRun(["--release"], {})).toThrow("Set EVAL_JUDGE_MODEL");
  });

  it("selects the bounded release profile exactly once with one run per current engine scenario", () => {
    const plan = parseV2EvalArgs(["--release"]);

    expect(plan).toBeDefined();
    expect(plan?.scope).toBe("release");
    expect(plan?.repeat).toBe(1);
    expect(plan?.scenarios.map((scenario) => scenario.id)).toEqual(v2ReleaseScenarioIds);
    expect(new Set(plan?.scenarios.map((scenario) => scenario.id)).size).toBe(6);
    expect(plan?.scenarios.map((scenario) => scenario.id)).toEqual(v2Scenarios.map((scenario) => scenario.id));
    expect(selectV2Scenarios(["--release"]).map((scenario) => scenario.id)).toEqual(v2ReleaseScenarioIds);
  });

  it("preserves exploratory scenario/all scopes and repeat controls", () => {
    expect(parseV2EvalArgs(["--scenario", "v2-exact-command-success", "--repeat", "3"])).toMatchObject({
      scope: "scenario",
      repeat: 3,
      requiresAllConfirmation: false
    });
    expect(parseV2EvalArgs(["--all"])?.requiresAllConfirmation).toBe(true);
    expect(parseV2EvalArgs(["--all", "--yes"])?.requiresAllConfirmation).toBe(false);
    expect(selectV2Scenarios(["--all"]).map((scenario) => scenario.id)).toEqual(v2Scenarios.map((scenario) => scenario.id));
  });

  it("rejects conflicting release scope flags before any model preflight", () => {
    const cases: Array<{ args: string[]; message: string }> = [
      { args: ["--release", "--all"], message: "Choose exactly one eval scope" },
      { args: ["--all", "--release"], message: "Choose exactly one eval scope" },
      { args: ["--release", "--scenario", "v2-exact-command-success"], message: "Choose exactly one eval scope" },
      { args: ["--release", "--repeat", "1"], message: "--release always runs each scenario once" },
      { args: ["--repeat", "2", "--release"], message: "--release always runs each scenario once" }
    ];

    for (const { args, message } of cases) {
      expect(() => parseV2EvalArgs(args), args.join(" ")).toThrow(message);
    }
  });

  it("rejects malformed scope and repeat arguments deterministically", () => {
    const cases: Array<{ args: string[]; message: string }> = [
      { args: ["--scenario"], message: "--scenario requires a scenario id" },
      { args: ["--scenario", "--all"], message: "--scenario requires a scenario id" },
      { args: ["--scenario", "missing"], message: "Unknown v2 scenario 'missing'." },
      { args: ["--scenario", "v2-exact-command-success", "--scenario", "v2-editor-unlocked"], message: "Specify --scenario at most once" },
      { args: ["--scenario", "v2-exact-command-success", "--repeat"], message: "--repeat requires a value" },
      { args: ["--scenario", "v2-exact-command-success", "--repeat", "0"], message: "--repeat must be 1, 2, or 3." },
      { args: ["--scenario", "v2-exact-command-success", "--repeat", "3", "--repeat", "2"], message: "Specify --repeat at most once" }
    ];

    for (const { args, message } of cases) {
      expect(() => parseV2EvalArgs(args), args.join(" ")).toThrow(message);
    }
  });
});
