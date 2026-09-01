import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

type PackageJson = { scripts: Record<string, string>; workspaces?: string[] };
type TsconfigJson = {
  extends?: string;
  compilerOptions?: {
    strict?: boolean;
    noEmit?: boolean;
    rootDir?: string;
    jsx?: string;
  };
  include?: string[];
  exclude?: string[];
};

const repoRoot = resolve(import.meta.dirname, "../../..");
const engineRoot = resolve(repoRoot, "tutorial-engine");

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

function requiredScript(packageJson: PackageJson, name: string): string {
  const command = packageJson.scripts[name];
  if (typeof command !== "string") {
    throw new Error(`Missing package script: ${name}`);
  }
  return command;
}

function shellChain(command: string): string[] {
  return command.split(" && ");
}

describe("evaluator package scripts", () => {
  it("keeps deterministic eval checks on v2 code and leaves live eval explicit", async () => {
    const packageJson = await readJson<PackageJson>(resolve(repoRoot, "package.json"));
    const enginePackageJson = await readJson<PackageJson>(resolve(engineRoot, "package.json"));
    const tsconfig = await readJson<TsconfigJson>(resolve(engineRoot, "evals/tsconfig.json"));

    expect(packageJson.workspaces).toEqual(["tutorial/workspaces/refactor-line/calculator", "tutorial-engine"]);
    expect(packageJson.scripts["check:eval"]).toBeUndefined();
    expect(packageJson.scripts["test:eval"]).toBeUndefined();
    expect(packageJson.scripts["check:eval:workbook"]).toBe("tsc -p evals/workbook/tsconfig.json");
    expect(packageJson.scripts["test:eval:workbook"]).toBe("vitest run evals/workbook/test/*.test.ts");
    expect(packageJson.scripts["eval:engine"]).toBe("npm run --workspace=tutorial-engine eval --");
    expect(packageJson.scripts["eval:release"]).toBe("npm run --workspace=tutorial-engine eval:release --");
    expect(packageJson.scripts.eval).toBe("npm run eval:engine --");
    expect(packageJson.scripts["eval:workbook"]).toBe("tsx evals/workbook/run.ts");
    expect(packageJson.scripts.test).toBe("node scripts/run-local-tests.mjs test");
    expect(packageJson.scripts["test:fast"]).toBe("node scripts/run-local-tests.mjs test:fast");
    expect(packageJson.scripts["test:engine"]).toBe("node scripts/run-local-tests.mjs test:engine");
    expect(packageJson.scripts["test:engine:fast"]).toBe("npm run --workspace=tutorial-engine test:fast --");
    expect(packageJson.scripts["test:workbook"]).toBe("node scripts/run-local-tests.mjs test:workbook");
    expect(packageJson.scripts["test:workbook:fast"]).toBe("node scripts/run-local-tests.mjs test:workbook:fast");

    expect(enginePackageJson.scripts["check:eval"]).toBe("tsc -p evals/tsconfig.json");
    // Asserted by property, not by exact string: the guarantees that matter are that this runs
    // the deterministic vitest suite over this checkout's eval tests only. Pinning the whole
    // command made fixing a broken exclusion fail the test, which taught nobody anything.
    const testEval = enginePackageJson.scripts["test:eval"] ?? "";
    expect(testEval).toMatch(/^vitest run /);
    expect(testEval).toContain("evals/test/*.test.ts");
    expect(testEval).not.toContain("evals/run.ts");
    expect(enginePackageJson.scripts.eval).toBe("npm run build && tsx evals/run.ts");
    expect(enginePackageJson.scripts["eval:release"]).toBe("npm run eval -- --release");

    expect(tsconfig.include).toEqual(["run.ts", "v2/**/*.ts", "test/**/*.test.ts"]);
    expect(tsconfig.exclude).toEqual(expect.arrayContaining(["harness", "scenarios", "reports"]));

    expect(requiredScript(enginePackageJson, "build:typescript")).toBe("rm -rf dist && tsc -p tsconfig.json");
    expect(shellChain(requiredScript(enginePackageJson, "build"))).toEqual(["npm run build:typescript", "npm run build:web:workbook"]);
    expect(shellChain(requiredScript(enginePackageJson, "test:fast"))).toEqual([
      "npm run lint",
      "tsc -p tsconfig.check.json",
      "npm run check:eval",
      "npm run test",
      "npm run build:web:workbook",
      "npm run browser:smoke"
    ]);
    expect(requiredScript(enginePackageJson, "test:fast")).not.toContain("tsc --noEmit");
    expect(requiredScript(enginePackageJson, "test:fast").match(/build:web:workbook/g) ?? []).toHaveLength(1);
    expect(shellChain(requiredScript(enginePackageJson, "check"))).toEqual(["npm run build:typescript", "npm run test:fast", "npm run check:workbook-terminal-image"]);
    expect(requiredScript(enginePackageJson, "prepublishOnly")).toBe("npm run check");
    expect(enginePackageJson.scripts["test:fast"]).toContain("npm run check:eval");
    expect(enginePackageJson.scripts["test:fast"]).toContain("npm run test");
    expect(enginePackageJson.scripts.check).toContain("npm run check:workbook-terminal-image");
    expect(enginePackageJson.scripts["test:fast"]).not.toContain("check:workbook-terminal-image");
    expect(enginePackageJson.scripts.check).not.toContain("npm run test:eval");
    expect(enginePackageJson.scripts.check).not.toContain("tsx evals/run.ts");
    expect(enginePackageJson.scripts.check).not.toContain("EVAL_JUDGE_MODEL");

    expect(packageJson.scripts.check).toBe("npm run test:fast");
    expect(packageJson.scripts["test:fast"]).toBe("node scripts/run-local-tests.mjs test:fast");
    expect(packageJson.scripts.check).not.toContain("--workspace=calculator");
    expect(packageJson.scripts.check).not.toContain("check:eval");
    expect(packageJson.scripts.check).not.toContain("test:eval");
    expect(packageJson.scripts.check).not.toContain("tsx evals/run.ts");
    expect(packageJson.scripts.check).not.toContain("EVAL_JUDGE_MODEL");
  });

  it("runs the release workflow through the engine check exactly once", async () => {
    const workflow = await readFile(resolve(repoRoot, ".github/workflows/release-gates.yml"), "utf8");
    const runSteps = [...workflow.matchAll(/^\s*- run: (.+)$/gm)].map((match) => match[1]);

    expect(runSteps).toEqual([
      "npm ci",
      "npm run --workspace=tutorial-engine browser:install:ci",
      "npm run --workspace=tutorial-engine check"
    ]);
    expect(runSteps).not.toContain("npm run --workspace=tutorial-engine build");
  });

  it("keeps tsconfig.check.json as a strict no-emit superset before test:fast drops redundant tsc --noEmit", async () => {
    const buildTsconfig = await readJson<TsconfigJson>(resolve(engineRoot, "tsconfig.json"));
    const checkTsconfig = await readJson<TsconfigJson>(resolve(engineRoot, "tsconfig.check.json"));

    expect(buildTsconfig.compilerOptions?.strict).toBe(true);
    expect(checkTsconfig.extends).toBe("./tsconfig.json");
    expect(checkTsconfig.compilerOptions?.noEmit).toBe(true);
    expect(checkTsconfig.include).toEqual(expect.arrayContaining(buildTsconfig.include ?? []));
    expect(checkTsconfig.include).toEqual(expect.arrayContaining([
      "test/**/*.ts",
      "test/**/*.tsx",
      "test/**/*.mts",
      "web-workbook/src/**/*.ts",
      "web-workbook/src/**/*.tsx",
      "web-workbook/src/**/*.d.ts"
    ]));
    expect(new Set(checkTsconfig.include).size).toBe(checkTsconfig.include?.length);
  });
});
