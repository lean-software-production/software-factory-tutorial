import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface StubInvocation { command: "pi" | "npm"; args: string[]; cwd: string; stdin: string; }
export interface FactoryStubResult {
  syntaxPassed: boolean;
  invocations: StubInvocation[];
  paused: boolean;
  output: string;
  reviewReportBeforeEnter?: string;
  reviewReportAfterEnter?: string;
  exitCode: number | null;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function expectedPiBeforePause(factoryScript: string): number {
  if (!/read\s+-r\s+-p/.test(factoryScript)) return 0;
  if (/review\.md\s+success\.md/.test(factoryScript)) return 2;
  return 1;
}

/**
 * Exercises factory/run.sh without spending model calls. The stubs are tiny
 * shell programs so tests observe pipes, cwd, arguments, tee, and Enter pauses
 * exactly as Bash sees them.
 */
export async function runFactoryWithStubs(factoryScript: string, reviewOutputs: string[] = ["VERDICT: PASS\n\nFINDINGS:\n- [PASS] passes tests: stub evidence\n"]): Promise<FactoryStubResult> {
  const root = await mkdtemp(join(tmpdir(), "factory-stub-"));
  const bin = join(root, "bin"); const factory = join(root, "factory"); const calculator = join(root, "calculator"); const log = join(root, "invocations.jsonl");
  await Promise.all([mkdir(bin), mkdir(factory), mkdir(calculator)]);
  await writeFile(join(factory, "run.sh"), factoryScript);
  await writeFile(join(factory, "refactor.md"), "refactor prompt\n");
  await writeFile(join(factory, "success.md"), "success prompt\n");
  await writeFile(join(factory, "review.md"), "review prompt\n");
  await writeFile(join(factory, "repair.md"), "repair prompt\n");
  const stub = `#!/usr/bin/env node
const fs = require('fs');
const isNpm = process.argv[1].endsWith('npm');
const input = isNpm ? '' : fs.readFileSync(0, 'utf8');
const entry = {command: isNpm ? 'npm' : 'pi', args: process.argv.slice(2), cwd: process.cwd(), stdin: input};
fs.appendFileSync(process.env.EVAL_STUB_LOG, JSON.stringify(entry) + '\\n');
if (!isNpm && input.includes('review prompt')) {
  const reviews = JSON.parse(process.env.EVAL_REVIEW_OUTPUTS || '[]');
  const lines = fs.readFileSync(process.env.EVAL_STUB_LOG, 'utf8').split('\\n').filter(Boolean).map(line => JSON.parse(line));
  const reviewIndex = lines.filter(line => line.command === 'pi' && line.stdin.includes('review prompt')).length - 1;
  process.stdout.write(reviews[reviewIndex] || reviews[reviews.length - 1] || 'VERDICT: PASS\\n');
}
`;
  await Promise.all([writeFile(join(bin, "pi"), stub), writeFile(join(bin, "npm"), stub)]);
  await Promise.all([chmod(join(bin, "pi"), 0o755), chmod(join(bin, "npm"), 0o755)]);
  const syntaxPassed = await new Promise<boolean>((resolve) => {
    const child = spawn("bash", ["-n", join(factory, "run.sh")]); child.once("close", (code) => resolve(code === 0));
  });
  if (!syntaxPassed) { await rm(root, { recursive: true, force: true }); return { syntaxPassed, invocations: [], paused: false, output: "", exitCode: 2 }; }

  const child = spawn("bash", [join(factory, "run.sh")], {
    cwd: factory,
    env: { PATH: `${bin}:${process.env.PATH ?? ""}`, EVAL_STUB_LOG: log, EVAL_REVIEW_OUTPUTS: JSON.stringify(reviewOutputs), HOME: root, CI: "1", NO_COLOR: "1" },
    stdio: ["pipe", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.on("data", (data) => { output += String(data); }); child.stderr.on("data", (data) => { output += String(data); });

  const expectedBeforePause = expectedPiBeforePause(factoryScript);
  let callsBeforeEnter = 0;
  if (expectedBeforePause > 0) {
    for (let tries = 0; tries < 100; tries++) {
      try { callsBeforeEnter = (await readFile(log, "utf8")).trim().split("\n").filter(Boolean).length; } catch { callsBeforeEnter = 0; }
      if (callsBeforeEnter >= expectedBeforePause) break;
      await wait(25);
    }
    await wait(50);
    try { callsBeforeEnter = (await readFile(log, "utf8")).trim().split("\n").filter(Boolean).length; } catch { callsBeforeEnter = 0; }
  } else {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 1000);
      child.once("close", () => { clearTimeout(timer); resolve(); });
    });
  }

  let reviewReportBeforeEnter: string | undefined;
  try { reviewReportBeforeEnter = await readFile(join(factory, "review-report.md"), "utf8"); } catch { /* absent unless lesson 004 tee ran */ }

  if (expectedBeforePause > 0) {
    child.stdin.write("\n");
    await wait(200);
    child.kill("SIGTERM");
  }
  const exitCode = await new Promise<number | null>((resolve) => {
    if (child.exitCode !== null) resolve(child.exitCode);
    else child.once("close", (code) => resolve(code));
  });
  let reviewReportAfterEnter: string | undefined;
  try { reviewReportAfterEnter = await readFile(join(factory, "review-report.md"), "utf8"); } catch { /* absent unless lesson 004 tee ran */ }
  let invocations: StubInvocation[] = [];
  try { invocations = (await readFile(log, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as StubInvocation); } catch { /* no invocation is assertion evidence */ }
  const paused = expectedBeforePause > 0 && callsBeforeEnter === expectedBeforePause;
  await rm(root, { recursive: true, force: true });
  return { syntaxPassed, invocations, paused, output, reviewReportBeforeEnter, reviewReportAfterEnter, exitCode };
}
