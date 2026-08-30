import { access, readdir, readFile, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "prerequisites");

const lesson003 = join(root, "lesson-003-prerequisites");
const lesson004 = join(root, "lesson-004-prerequisites");
const completed013 = join(root, "completed-factory-lesson-013");

const completedScripts = [
  "factory/refactor/do.sh",
  "factory/refactor/validate.sh",
  "factory/refactor/run.sh",
  "factory/watch.sh",
  "factory/ask.sh",
  "factory/steer.sh"
];

const completedPrompts = [
  "factory/refactor/refactor.md",
  "factory/refactor/validate.md",
  "factory/refactor/repair.md",
  "factory/refactor/commit.md",
  "factory/refactor/success.md"
];

describe("workbook evaluator prerequisite seeds", () => {
  it("ships disposable root-owned fixtures with executable bits and valid Bash syntax, with no generated .tmp state", async () => {
    await access(join(root, "README.md"), constants.R_OK);
    await expect(access(join(root, "manifest.json"), constants.R_OK)).resolves.toBeUndefined();

    const allPaths = await listFiles(root);
    expect(allPaths).toContain("lesson-003-prerequisites/factory/refactor-do.sh");
    expect(allPaths).toContain("lesson-004-prerequisites/factory/refactor-validate.sh");
    expect(allPaths).toContain("completed-factory-lesson-013/factory/refactor/run.sh");
    expect(allPaths.some((path) => path.startsWith("../../tutorial/"))).toBe(false);
    expect(allPaths.filter((path) => path.split("/").includes(".tmp"))).toEqual([]);
    expect(allPaths.filter((path) => /\.jsonl$|quality-before|validate-findings|evidence\.txt|commit-message|run-output|watch-tools|control$/.test(path))).toEqual([]);

    for (const script of [
      join(lesson003, "factory/refactor-do.sh"),
      join(lesson004, "factory/refactor-do.sh"),
      join(lesson004, "factory/refactor-validate.sh"),
      ...completedScripts.map((script) => join(completed013, script))
    ]) {
      await expect(access(script, constants.X_OK)).resolves.toBeUndefined();
      await expect(execFileAsync("bash", ["-n", script])).resolves.toMatchObject({ stderr: "" });
    }
  });

  it("models honest lesson 003 and lesson 004 prerequisites without claiming learner progress", async () => {
    await expectFiles(lesson003, ["factory/refactor.md", "factory/refactor-do.sh"]);
    await expectFiles(lesson004, [
      "factory/refactor.md",
      "factory/refactor-do.sh",
      "factory/refactor-validate.md",
      "factory/refactor-validate.sh"
    ]);

    const lesson003Do = await file(lesson003, "factory/refactor-do.sh");
    expect(lesson003Do).toContain("mkdir -p .tmp");
    expect(lesson003Do).toContain("> .tmp/refactor-quality-before.txt || true");
    expect(lesson003Do).toContain("pi --no-session --tools read,edit,write,grep,find,ls -p");
    expect(lesson003Do).not.toContain("bash -p");

    const lesson004Validate = await file(lesson004, "factory/refactor-validate.sh");
    expect(lesson004Validate).toContain("[ ! -f .tmp/refactor-quality-before.txt ]");
    expect(lesson004Validate).toContain("cat refactor-validate.md .tmp/refactor-quality-before.txt");
    expect(lesson004Validate).toContain("pi --no-session --tools read,grep,find,ls,bash -p");
    expect(lesson004Validate).toContain("tee .tmp/refactor-validate-findings.txt");

    const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8")) as { schema: string; owner: string; runtime: { canonical: string; linePath: string; operatorLineArgument: string }; seeds: Array<{ id: string; sourceLessons: string[]; claimsLearnerProgress: boolean; materialization: { target: string; mode: string } }> };
    expect(manifest.schema).toBe("workbook-evaluator-prerequisite-seeds/v1");
    expect(manifest.owner).toBe("evals/workbook");
    expect(manifest.runtime).toEqual({ canonical: "Linux workbook terminal/Docker", linePath: "factory/refactor", operatorLineArgument: "refactor" });
    expect(manifest.seeds.map((seed) => seed.id)).toEqual(["lesson-003-prerequisites", "lesson-004-prerequisites", "completed-factory-lesson-013"]);
    expect(manifest.seeds.find((seed) => seed.id === "completed-factory-lesson-013")?.sourceLessons).toEqual([
      "005-join-them-into-a-line",
      "006-read-only-validator",
      "007-compose-and-branch",
      "008-take-the-pause-off",
      "009-record-what-happened",
      "010-watch-it-while-it-runs",
      "011-ask-what-happened",
      "012-talk-to-a-station"
    ]);
    for (const seed of manifest.seeds) {
      expect(seed.claimsLearnerProgress).toBe(false);
      expect(seed.materialization).toEqual({ target: "refactor-line workspace root", mode: "copy as disposable input" });
    }
  });

  it("matches the completed lesson 013 factory topology required by authored lessons 005 through 012", async () => {
    await expectFiles(completed013, [...completedScripts, ...completedPrompts]);
    const allPaths = await listFiles(completed013);

    expect(allPaths).not.toContain("factory/refactor-do.sh");
    expect(allPaths).not.toContain("factory/refactor-validate.sh");
    expect(allPaths).not.toContain("factory/refactor-quality-before.txt");
    expect(allPaths).not.toContain("factory/refactor-validate-findings.txt");
    expect(allPaths.filter((path) => path.startsWith("factory/refactor/")).sort()).toEqual([
      "factory/refactor/commit.md",
      "factory/refactor/do.sh",
      "factory/refactor/refactor.md",
      "factory/refactor/repair.md",
      "factory/refactor/run.sh",
      "factory/refactor/success.md",
      "factory/refactor/validate.md",
      "factory/refactor/validate.sh"
    ]);
  });

  it("keeps station tool boundaries explicit and prevents validators, committers, askers, and watchers from editing", async () => {
    const doScript = await file(completed013, "factory/refactor/do.sh");
    const validateScript = await file(completed013, "factory/refactor/validate.sh");
    const runScript = await file(completed013, "factory/refactor/run.sh");
    const askScript = await file(completed013, "factory/ask.sh");
    const watchScript = await file(completed013, "factory/watch.sh");

    expect(doScript).toContain("pi --no-session --tools read,edit,write,grep,find,ls -p");
    expect(validateScript).toContain("pi --no-session --tools read,grep,find,ls -p");
    expect(validateScript).not.toMatch(/--tools [^\n]*bash/);

    expect(runScript).toContain("pi --no-session --mode rpc \\");
    expect(runScript).toContain("--tools read,edit,write,grep,find,ls");
    expect(runScript).toContain("pi --no-session --mode json \\");
    expect(runScript).toContain("--tools read,grep,find,ls -p");
    expect(runScript).not.toMatch(/validate\.md[\s\S]*--tools [^\n]*bash/);
    expect(runScript).not.toMatch(/commit\.md[\s\S]*--tools [^\n]*(edit|write|bash)/);

    expect(askScript).toContain("pi --no-session --no-tools -p");
    expect(watchScript).not.toContain("pi --no-session");
  });

  it("carries evidence between stations instead of making stations fetch learner/session state", async () => {
    const validateScript = await file(completed013, "factory/refactor/validate.sh");
    const runScript = await file(completed013, "factory/refactor/run.sh");
    const validatePrompt = await file(completed013, "factory/refactor/validate.md");
    const repairPrompt = await file(completed013, "factory/refactor/repair.md");

    for (const script of [validateScript, runScript]) {
      expect(script).toContain("echo \"=== QUALITY BEFORE (recorded before the doer ran) ===\"");
      expect(script).toContain("echo \"=== QUALITY NOW ===\"");
      expect(script).toContain("echo \"=== TESTS ===\"");
      expect(script).toContain("echo \"=== WORKING DIFF ===\"");
      expect(script).toContain("git diff -- .");
      expect(script).toContain("> .tmp/evidence.txt");
      expect(script).toContain("cat validate.md success.md .tmp/evidence.txt");
    }

    expect(runScript).toContain("cat repair.md success.md .tmp/validate-findings.txt");
    expect(runScript).toContain("cat commit.md success.md .tmp/validate-findings.txt .tmp/evidence.txt");
    expect(validatePrompt).toContain("The evidence arrives appended below");
    expect(validatePrompt).not.toContain("Run `node scripts/quality.mjs`");
    expect(repairPrompt).toContain("The validator's findings arrive appended below");
  });

  it("uses the anchored verdict parser and fails closed when the verdict is unreadable", async () => {
    const runScript = await file(completed013, "factory/refactor/run.sh");
    expect(runScript).toContain("grep -m1 -o '^VERDICT: \\(PASS\\|FAIL\\)'");
    expect(runScript).toContain("|| echo \"VERDICT: FAIL\"");

    await expect(execFileAsync("bash", ["-c", "printf 'The code looks fine.\\n' > d.txt; grep -m1 -o '^VERDICT: \\(PASS\\|FAIL\\)' d.txt || echo 'VERDICT: FAIL'; rm d.txt"])).resolves.toMatchObject({ stdout: "VERDICT: FAIL\n" });
    await expect(execFileAsync("bash", ["-c", "printf 'must be VERDICT: PASS or VERDICT: FAIL, and mine is:\\nVERDICT: FAIL\\n' > d.txt; grep -m1 -o '^VERDICT: \\(PASS\\|FAIL\\)' d.txt || echo 'VERDICT: FAIL'; rm d.txt"])).resolves.toMatchObject({ stdout: "VERDICT: FAIL\n" });
  });

  it("keeps event producers and consumers on the authored .tmp/events path", async () => {
    const runScript = await file(completed013, "factory/refactor/run.sh");
    const watchScript = await file(completed013, "factory/watch.sh");
    const askScript = await file(completed013, "factory/ask.sh");

    expect(runScript).toContain("mkdir -p .tmp/events");
    for (const station of ["do", "validate", "repair", "commit"]) {
      expect(runScript).toContain(`.tmp/events/$iteration-${station}.jsonl`);
    }
    expect(watchScript).toContain('"$line"/.tmp/events/*.jsonl');
    expect(askScript).toContain('"$line"/.tmp/events/*.jsonl');
    expect(`${runScript}\n${watchScript}\n${askScript}`).not.toContain('"$line"/events/*.jsonl');
    expect(`${runScript}\n${watchScript}\n${askScript}`).not.toContain("factory/refactor/events/");
  });

  it("preserves the current Linux workbook-terminal RPC and operator-script mechanics", async () => {
    const readme = await readFile(join(root, "README.md"), "utf8");
    const runScript = await file(completed013, "factory/refactor/run.sh");
    const watchScript = await file(completed013, "factory/watch.sh");
    const askScript = await file(completed013, "factory/ask.sh");
    const steerScript = await file(completed013, "factory/steer.sh");

    expect(readme).toContain("Linux workbook terminal/Docker runtime");
    expect(readme).toContain("fixed in-workspace line path `factory/refactor`");
    expect(runScript).toContain("mkfifo control .tmp/rpc-input");
    expect(runScript).toContain('createReadStream("control").pipe(process.stdout, { end: false });');
    expect(runScript).toContain('setInterval(() => {}, 2 ** 30);');
    expect(runScript).toContain('wait "$producer"');
    expect(runScript).toContain("< .tmp/rpc-input");
    expect(watchScript).toContain('line="${1:?usage: watch.sh <line>}"');
    expect(askScript).toContain('line="${1:?usage: ask.sh <line> <question>}"');
    expect(steerScript).toContain('line="${1:?usage: steer.sh <line> <message>}"');
    expect(watchScript).toContain('tail -f -n +1 "$line"/.tmp/events/*.jsonl');
    expect(askScript).toContain('"$line"/.tmp/events/*.jsonl');
    expect(steerScript).toContain('> "$line"/control');
  });

  it("bounds unattended stopping according to lesson 008", async () => {
    const runScript = await file(completed013, "factory/refactor/run.sh");
    expect(runScript).toContain("max_iterations=5");
    expect(runScript).toContain("iteration=0");
    expect(runScript).toContain("consecutive_failures=0");
    expect(runScript).toContain('while [ "$iteration" -lt "$max_iterations" ]; do');
    expect(runScript).toContain("iteration=$((iteration + 1))");
    expect(runScript).toContain('echo "=== Iteration $iteration of $max_iterations ==="');
    expect(runScript).toContain("consecutive_failures=$((consecutive_failures + 1))");
    expect(runScript).toContain("consecutive_failures=0");
    expect(runScript).toContain('[ "$consecutive_failures" -ge 2 ]');
    expect(runScript).toContain('echo "Stopping: two failing verdicts in a row."');
    expect(runScript).toContain('echo "Line finished after $iteration iterations."');
    expect(runScript).not.toMatch(/read -r|-p "Press Enter/);
  });
});

async function expectFiles(base: string, paths: string[]): Promise<void> {
  for (const path of paths) await expect(access(join(base, path), constants.R_OK)).resolves.toBeUndefined();
}

async function file(base: string, path: string): Promise<string> {
  return readFile(join(base, path), "utf8");
}

async function listFiles(base: string): Promise<string[]> {
  const results: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name);
      const path = relative(base, absolute).replaceAll("\\", "/");
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile() || entry.isSymbolicLink()) results.push(path);
      else {
        const mode = (await stat(absolute)).mode;
        if (mode) results.push(path);
      }
    }
  }
  await walk(base);
  return results.sort();
}
