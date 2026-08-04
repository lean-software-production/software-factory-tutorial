import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface StubInvocation { command: "pi" | "npm"; args: string[]; cwd: string; stdin: string; }

export interface FactoryStubOptions {
  /** Workspace-relative path of the script to run, e.g. "factory/refactor-do.sh". */
  scriptPath: string;
  script: string;
  /** Workspace-relative files to seed — prompts, baselines — mapping path to contents. */
  files: Record<string, string>;
  /** Stubbed validator stdout, consumed in order. */
  validatorOutputs?: string[];
  /** Workspace-relative file whose contents are captured before and after Enter. */
  reportPath?: string;
}

export interface FactoryStubResult {
  syntaxPassed: boolean;
  invocations: StubInvocation[];
  paused: boolean;
  output: string;
  reportBeforeEnter?: string;
  reportAfterEnter?: string;
  exitCode: number | null;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** True when the script hands control back at an Enter prompt. */
function pausesForEnter(script: string): boolean {
  return /read\s+-r\s+-p/.test(script);
}

/**
 * The most Pi turns a single iteration can spend. Counting the `pi` commands in
 * the script is an upper bound rather than an expectation: a verdict branch
 * contributes a turn only when the verdict is a failure. A second iteration
 * would exceed this bound, which is what makes it useful evidence of a pause.
 */
function maxPiPerIteration(script: string): number {
  return (script.match(/(^|[\s(;&|])pi\s/g) ?? []).length;
}

async function countInvocations(log: string): Promise<number> {
  try { return (await readFile(log, "utf8")).trim().split("\n").filter(Boolean).length; } catch { return 0; }
}

/**
 * Exercises a lesson's shell script without spending model calls. The stubs are
 * tiny programs so tests observe pipes, cwd, arguments, tee, and Enter pauses
 * exactly as Bash sees them. The script is spawned from its own directory, so a
 * flat `factory/refactor-do.sh` and a nested `factory/refactor/run.sh` each
 * reach the stub `calculator/` by the relative path the learner wrote.
 */
export async function runFactoryWithStubs(options: FactoryStubOptions): Promise<FactoryStubResult> {
  const validatorOutputs = options.validatorOutputs ?? ["VERDICT: PASS\n\nFINDINGS:\n- [PASS] passes tests: stub evidence\n"];
  const root = await mkdtemp(join(tmpdir(), "factory-stub-"));
  const bin = join(root, "bin");
  const log = join(root, "invocations.jsonl");
  await Promise.all([mkdir(bin), mkdir(join(root, "calculator"), { recursive: true })]);

  const scriptFile = join(root, options.scriptPath);
  await mkdir(dirname(scriptFile), { recursive: true });
  await writeFile(scriptFile, options.script);
  for (const [path, contents] of Object.entries(options.files)) {
    const file = join(root, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, contents);
  }

  const stub = `#!/usr/bin/env node
const fs = require('fs');
const isNpm = process.argv[1].endsWith('npm');
const input = isNpm ? '' : fs.readFileSync(0, 'utf8');
const entry = {command: isNpm ? 'npm' : 'pi', args: process.argv.slice(2), cwd: process.cwd(), stdin: input};
fs.appendFileSync(process.env.EVAL_STUB_LOG, JSON.stringify(entry) + '\\n');
if (!isNpm && input.includes('validate prompt')) {
  const outputs = JSON.parse(process.env.EVAL_VALIDATOR_OUTPUTS || '[]');
  const lines = fs.readFileSync(process.env.EVAL_STUB_LOG, 'utf8').split('\\n').filter(Boolean).map(line => JSON.parse(line));
  const index = lines.filter(line => line.command === 'pi' && line.stdin.includes('validate prompt')).length - 1;
  process.stdout.write(outputs[index] || outputs[outputs.length - 1] || 'VERDICT: PASS\\n');
}
`;
  await Promise.all([writeFile(join(bin, "pi"), stub), writeFile(join(bin, "npm"), stub)]);
  await Promise.all([chmod(join(bin, "pi"), 0o755), chmod(join(bin, "npm"), 0o755)]);
  const syntaxPassed = await new Promise<boolean>((resolve) => {
    const child = spawn("bash", ["-n", scriptFile]); child.once("close", (code) => resolve(code === 0));
  });
  if (!syntaxPassed) { await rm(root, { recursive: true, force: true }); return { syntaxPassed, invocations: [], paused: false, output: "", exitCode: 2 }; }

  const child = spawn("bash", [scriptFile], {
    cwd: dirname(scriptFile),
    env: { PATH: `${bin}:${process.env.PATH ?? ""}`, EVAL_STUB_LOG: log, EVAL_VALIDATOR_OUTPUTS: JSON.stringify(validatorOutputs), HOME: root, CI: "1", NO_COLOR: "1" },
    stdio: ["pipe", "pipe", "pipe"]
  });
  let output = "";
  let exited = false;
  child.once("close", () => { exited = true; });
  child.stdout.on("data", (data) => { output += String(data); }); child.stderr.on("data", (data) => { output += String(data); });

  const pausing = pausesForEnter(options.script);
  let callsBeforeEnter = 0;
  let waitingAtEnter = false;
  if (pausing) {
    // Bash does not echo `read -p` when stdin is a pipe, so the pause is
    // observed rather than announced: wait until the invocation log has stopped
    // growing for long enough that the script can only be blocked on the Enter.
    let settledPolls = 0;
    for (let tries = 0; tries < 240 && !exited; tries++) {
      const count = await countInvocations(log);
      settledPolls = count === callsBeforeEnter ? settledPolls + 1 : 0;
      callsBeforeEnter = count;
      if (count > 0 && settledPolls >= 12) break;
      await wait(25);
    }
    callsBeforeEnter = await countInvocations(log);
    // Recorded before the Enter is written, because the script exits soon after.
    waitingAtEnter = !exited;
  } else {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 1000);
      child.once("close", () => { clearTimeout(timer); resolve(); });
    });
  }

  let reportBeforeEnter: string | undefined;
  if (options.reportPath) {
    try { reportBeforeEnter = await readFile(join(root, options.reportPath), "utf8"); } catch { /* absent until the tee runs */ }
  }

  if (pausing) {
    child.stdin.write("\n");
    await wait(200);
    child.kill("SIGTERM");
  }
  const exitCode = await new Promise<number | null>((resolve) => {
    if (child.exitCode !== null) resolve(child.exitCode);
    else child.once("close", (code) => resolve(code));
  });
  let reportAfterEnter: string | undefined;
  if (options.reportPath) {
    try { reportAfterEnter = await readFile(join(root, options.reportPath), "utf8"); } catch { /* absent until the tee runs */ }
  }
  let invocations: StubInvocation[] = [];
  try { invocations = (await readFile(log, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as StubInvocation); } catch { /* no invocation is assertion evidence */ }
  const paused = waitingAtEnter && callsBeforeEnter > 0 && callsBeforeEnter <= maxPiPerIteration(options.script);
  await rm(root, { recursive: true, force: true });
  return { syntaxPassed, invocations, paused, output, reportBeforeEnter, reportAfterEnter, exitCode };
}
