import { access, readFile } from "node:fs/promises";
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

const repoRoot = resolve(import.meta.dirname, "../..");
const engineRoot = resolve(repoRoot, "tutorial-engine");

type PackageJson = {
  scripts: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

async function readJson(path: string): Promise<PackageJson> {
  return JSON.parse(await readFile(path, "utf8")) as PackageJson;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function requiredScript(manifest: PackageJson, name: string): string {
  const script = manifest.scripts[name];
  expect(script, `${name} script is not declared`).toBeDefined();
  return script as string;
}

function shellSteps(script: string): string[] {
  return script.split("&&").map((step) => step.trim());
}

describe("root visual package contract", () => {
  it("delegates root check:visual directly to the engine-owned canonical command", async () => {
    const manifest = await readJson(resolve(repoRoot, "package.json"));

    const checkVisual = requiredScript(manifest, "check:visual");

    expect(checkVisual).toBe("npm run --workspace=tutorial-engine test:visual");
    expect(checkVisual).not.toContain(" -- ");
    expect(checkVisual).not.toContain("approve:visual");
  });

  it("keeps visual validation in root check while approval stays a separate deliberate command", async () => {
    const manifest = await readJson(resolve(repoRoot, "package.json"));
    const checkSteps = shellSteps(requiredScript(manifest, "check"));

    expect(checkSteps).toContain("npm run check:visual");
    expect(checkSteps.some((step) => step.includes("approve:visual"))).toBe(false);
    expect(requiredScript(manifest, "approve:visual")).toBe("node scripts/approve-visual.mjs");
  });

  it("removes the changed-file visual gate and its trigger tests", async () => {
    await expect(exists(resolve(repoRoot, "scripts/check-visual.mjs"))).resolves.toBe(false);
    await expect(exists(resolve(engineRoot, "test/check-visual-surface.test.ts"))).resolves.toBe(false);
  });
});

describe("canonical visual test command", () => {
  it("exposes one public engine-owned package script", async () => {
    const manifest = await readJson(resolve(engineRoot, "package.json"));

    expect(requiredScript(manifest, "test:visual")).toBe("node scripts/test-visual.mjs");
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

describe("rendering dependency pins", () => {
  // These exact versions keep approved screenshots deterministic. Loosen one back to a range and
  // npm can update rendering code through package-lock.json without a deliberate manifest edit.
  const pinned = [
    "@codemirror/commands",
    "@codemirror/state",
    "@codemirror/view",
    "@vitejs/plugin-react",
    "@xterm/addon-fit",
    "@xterm/xterm",
    "highlight.js",
    "mermaid",
    "react",
    "react-dom",
    "react-markdown",
    "rehype-highlight",
    "remark-gfm",
    "vite",
    "playwright",
  ];

  it.each(pinned)("pins %s to an exact version for deterministic approved screenshots", async (name) => {
    const manifest = await readJson(resolve(engineRoot, "package.json"));
    const declared = manifest.dependencies?.[name] ?? manifest.devDependencies?.[name];

    expect(declared, `${name} is not declared in tutorial-engine/package.json`).toBeDefined();
    expect(declared).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  });
});
