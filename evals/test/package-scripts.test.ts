import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

type PackageJson = { scripts: Record<string, string>; workspaces: string[] };
type TsconfigJson = { include?: string[]; exclude?: string[] };

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

describe("evaluator package scripts", () => {
  it("keeps deterministic eval checks on v2 code and leaves live eval explicit", async () => {
    const packageJson = await readJson<PackageJson>("package.json");
    const tsconfig = await readJson<TsconfigJson>("evals/tsconfig.json");

    expect(packageJson.workspaces).toEqual(["tutorial/calculator", "tutorial-engine"]);
    expect(packageJson.scripts["check:eval"]).toBe("tsc -p evals/tsconfig.json");
    expect(packageJson.scripts["test:eval"]).toBe("vitest run --root . --exclude '.worktrees/**' ./evals/test/*.test.ts");
    expect(packageJson.scripts.eval).toBe("npm run --workspace=tutorial-engine build && tsx evals/run.ts");

    expect(tsconfig.include).toEqual(["run.ts", "v2/**/*.ts", "test/**/*.test.ts"]);
    expect(tsconfig.exclude).toEqual(expect.arrayContaining(["harness", "scenarios", "reports"]));

    expect(packageJson.scripts.check).toContain("npm run check:eval");
    expect(packageJson.scripts.check).toContain("npm run test:eval");
    expect(packageJson.scripts.check).toContain("npm run --workspace=tutorial-engine check");
    expect(packageJson.scripts.check).toContain("npm run --workspace=tutorial/calculator test");
    expect(packageJson.scripts.check).not.toContain("--workspace=calculator");
    expect(packageJson.scripts.check).not.toContain("npm run eval");
    expect(packageJson.scripts.check).not.toContain("tsx evals/run.ts");
    expect(packageJson.scripts.check).not.toContain("EVAL_JUDGE_MODEL");
  });
});
