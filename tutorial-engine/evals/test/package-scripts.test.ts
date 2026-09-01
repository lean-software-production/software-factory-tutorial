import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

type PackageJson = { scripts: Record<string, string> };
type TsconfigJson = {
  extends?: string;
  compilerOptions?: {
    strict?: boolean;
    noEmit?: boolean;
  };
  include?: string[];
  exclude?: string[];
};

const engineRoot = resolve(import.meta.dirname, "../..");

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

function dockerIgnorePatterns(text: string): string[] {
  return text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0 && !line.startsWith("#"));
}

function globPatternSource(pattern: string): string {
  let source = "";
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index]!;
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        source += ".*";
        index++;
      } else {
        source += "[^/]*";
      }
    } else {
      source += character.replace(/[\\^$+?.()|[\]{}]/g, "\\$&");
    }
  }
  return source;
}

function contextIgnores(patterns: string[], contextPath: string): boolean {
  return patterns.some((pattern) => {
    const normalizedPattern = pattern.replace(/^\.\//, "").replace(/^\//, "").replace(/\/$/, "");
    const source = globPatternSource(normalizedPattern);
    const regex = normalizedPattern.includes("/") ? new RegExp(`^${source}(?:/.*)?$`) : new RegExp(`(?:^|.*/)${source}(?:/.*)?$`);
    return regex.test(contextPath);
  });
}

describe("evaluator package scripts", () => {
  it("keeps deterministic eval checks on synthetic v2 code and leaves live eval explicit", async () => {
    const enginePackageJson = await readJson<PackageJson>(resolve(engineRoot, "package.json"));
    const tsconfig = await readJson<TsconfigJson>(resolve(engineRoot, "evals/tsconfig.json"));

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
  });

  it("keeps engine checks model-free and leaves Docker image readiness out of test:fast", async () => {
    const enginePackageJson = await readJson<PackageJson>(resolve(engineRoot, "package.json"));

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
  });

  it("builds the generic workbook terminal image from the engine package context", async () => {
    const enginePackageJson = await readJson<PackageJson>(resolve(engineRoot, "package.json"));
    const patterns = dockerIgnorePatterns(await readFile(resolve(engineRoot, ".dockerignore"), "utf8"));

    expect(requiredScript(enginePackageJson, "build:workbook-terminal")).toBe("docker build --tag lean-software-production/workbook-terminal:latest --file docker/workbook-terminal.Dockerfile .");
    expect([
      "node_modules/typescript/package.json",
      "src/fixtures/node_modules/cache/index.js",
      "dist/workbook/cli.js",
      "web-workbook/dist/assets/index.js",
      "test/.tmp/workbook-state.json",
      "test/workbook-ux/.tmp/trace.json",
      "test/visual/terminal-band.received.png",
      "evals/reports/latest.json",
      "evals/v2/reports/run.json",
      "reports/manual-check.json",
      "src/workbook/.tmp/runtime.json",
      "tmp/build-output.log"
    ].filter((contextPath) => !contextIgnores(patterns, contextPath))).toEqual([]);
    expect(contextIgnores(patterns, "docker/workbook-terminal.Dockerfile")).toBe(false);
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
