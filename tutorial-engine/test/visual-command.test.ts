import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// test:visual is a plain Node ESM script so npm can run it without a TypeScript loader.
// @ts-ignore TS has no declaration file for that script.
const visualCommand = await import("../scripts/test-visual.mjs");
const {
  CANONICAL_DEVCONTAINER_ENV,
  CANONICAL_PI_AGENT_DIR,
  assertNoVisualArgs,
  devcontainerState,
  repositoryRoot,
  visualTestPlan,
} = visualCommand;

describe("canonical visual test command", () => {
  it("exposes one public engine-owned package script", async () => {
    const manifest = JSON.parse(await readFile(resolve(import.meta.dirname, "../package.json"), "utf8"));

    expect(manifest.scripts["test:visual"]).toBe("node scripts/test-visual.mjs");
    expect(Object.keys(manifest.scripts).filter((name) => name.includes("visual"))).toEqual(["test:visual"]);
  });

  it("recognises the canonical repository devcontainer", () => {
    const state = devcontainerState({
      platform: "linux",
      dockerMarkerExists: true,
      env: { [CANONICAL_DEVCONTAINER_ENV]: "1", PI_CODING_AGENT_DIR: CANONICAL_PI_AGENT_DIR },
    });

    expect(state).toEqual({ inContainer: true, canonical: true });
  });

  it("refuses a noncanonical container instead of recursing into devcontainer", () => {
    const dockerPlan = visualTestPlan({
      repositoryRoot: "/repo",
      state: devcontainerState({ platform: "linux", dockerMarkerExists: true, env: {} }),
    });
    const otherContainerPlan = visualTestPlan({
      repositoryRoot: "/repo",
      state: devcontainerState({ platform: "linux", dockerMarkerExists: false, otherContainerMarkerExists: true, env: {} }),
    });

    expect(dockerPlan).toMatchObject({ kind: "refuse", commands: [] });
    expect(otherContainerPlan).toMatchObject({ kind: "refuse", commands: [] });
  });

  it("enters the devcontainer from a non-container host and re-invokes the public command", () => {
    const plan = visualTestPlan({
      repositoryRoot: "/tmp/worktree with spaces",
      state: devcontainerState({ platform: "linux", dockerMarkerExists: false, otherContainerMarkerExists: false, env: {} }),
    });

    expect(plan.kind).toBe("devcontainer");
    expect(plan.commands).toHaveLength(2);
    expect(plan.commands[1]).toMatchObject({ command: "devcontainer" });
    expect(plan.commands[1].args).toContain("/tmp/worktree with spaces");
    expect(plan.commands[1].args.slice(-4)).toEqual(["npm", "run", "--workspace=tutorial-engine", "test:visual"]);
  });

  it("builds the workbook bundle before running the visual harness in the direct path", () => {
    const plan = visualTestPlan({
      repositoryRoot: "/repo",
      state: devcontainerState({
        platform: "linux",
        dockerMarkerExists: true,
        env: { [CANONICAL_DEVCONTAINER_ENV]: "1", PI_CODING_AGENT_DIR: CANONICAL_PI_AGENT_DIR },
      }),
    });

    expect(plan.kind).toBe("direct");
    expect(plan.commands.map((command: { args: string[] }) => command.args.join(" "))).toEqual([
      "run --workspace=tutorial-engine build:web:workbook",
      "exec --workspace=tutorial-engine -- tsx test/visual-affordances.mts",
    ]);
  });

  it("rejects all arguments so validation cannot approve screenshots", () => {
    expect(() => assertNoVisualArgs([])).not.toThrow();
    expect(() => assertNoVisualArgs(["--update"])).toThrow(/does not accept arguments/);
    expect(() => assertNoVisualArgs(["--grep", "band"])).toThrow(/does not accept arguments/);
  });

  it("finds the repository root from the script path rather than process cwd", () => {
    expect(repositoryRoot("/tmp/worktrees/name with spaces/tutorial-engine/scripts")).toBe(
      "/tmp/worktrees/name with spaces",
    );
  });
});
