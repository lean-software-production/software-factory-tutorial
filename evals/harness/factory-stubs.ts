import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface StubInvocation { command: "pi" | "npm" | "git"; args: string[]; cwd: string; stdin: string; }

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
  /** Arguments the script is invoked with, for the operating scripts that take a line name. */
  args?: string[];
}

export interface FactoryStubResult {
  syntaxPassed: boolean;
  invocations: StubInvocation[];
  paused: boolean;
  /** Model turns spent before Enter was written; every turn, for a script that never pauses. */
  callsBeforeEnter: number;
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

async function readInvocations(log: string): Promise<StubInvocation[]> {
  try { return (await readFile(log, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as StubInvocation); } catch { return []; }
}

/** Counts model turns only, so the tally and `maxPiPerIteration` measure the same thing. */
async function countPiTurns(log: string): Promise<number> {
  return (await readInvocations(log)).filter((entry) => entry.command === "pi").length;
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

  // One program stands in for every external command the lessons call. `git`
  // matters from lesson 007, where the commit station is the first thing on the
  // line to write something the next run can still see; `--mode json` and
  // `--mode rpc` matter from 009 and 012, where the line stops reading prose.
  const stub = `#!/usr/bin/env node
const fs = require('fs');
const name = process.argv[1].split('/').pop();
const args = process.argv.slice(2);
const record = (stdin) => fs.appendFileSync(process.env.EVAL_STUB_LOG,
  JSON.stringify({command: name, args, cwd: process.cwd(), stdin}) + '\\n');

if (name === 'npm') { record(''); process.exit(0); }
if (name === 'git') {
  record('');
  if (args[0] === 'diff') process.stdout.write('diff --git a/src/calc.ts b/src/calc.ts\\n+ stub change\\n');
  process.exit(0);
}

const modeAt = args.indexOf('--mode');
const mode = modeAt >= 0 ? args[modeAt + 1] : 'text';

function reply(input) {
  if (input.includes('validate prompt')) {
    const outputs = JSON.parse(process.env.EVAL_VALIDATOR_OUTPUTS || '[]');
    const lines = fs.readFileSync(process.env.EVAL_STUB_LOG, 'utf8').split('\\n').filter(Boolean).map(line => JSON.parse(line));
    const index = lines.filter(line => line.command === 'pi' && line.stdin.includes('validate prompt')).length - 1;
    return outputs[index] || outputs[outputs.length - 1] || 'VERDICT: PASS\\n';
  }
  if (input.includes('commit prompt')) return 'Extract the duplicated formatting branch\\n\\nMoves one copy into the formatter, towards no duplication.\\n';
  return '';
}

/** The subset of Pi's event stream the lessons actually read back. */
function emit(text) {
  const message = {role: 'assistant', content: [{type: 'text', text}],
    usage: {input: 100, output: 50, cost: {input: 0.0003, output: 0.0007, total: 0.001}}};
  const write = (event) => process.stdout.write(JSON.stringify(event) + '\\n');
  write({type: 'agent_start'});
  write({type: 'tool_execution_start', toolCallId: 'call_1', toolName: 'read', args: {path: 'src/calc.ts'}});
  write({type: 'message_update', message, assistantMessageEvent: {type: 'text_delta', contentIndex: 0, delta: text}});
  write({type: 'message_end', message});
  write({type: 'agent_end', messages: [message]});
}

if (mode === 'rpc') {
  // stdin is a fifo held open by another process, so it cannot be read to EOF.
  let buffer = '';
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\\n')) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      let command; try { command = JSON.parse(line); } catch { continue; }
      if (command.type !== 'prompt') continue;
      record(command.message || '');
      emit(reply(command.message || ''));
      process.exit(0);
    }
  });
  return;
}

const input = fs.readFileSync(0, 'utf8');
record(input);
if (mode === 'json') emit(reply(input));
else process.stdout.write(reply(input));
`;
  await Promise.all(["pi", "npm", "git"].map((command) => writeFile(join(bin, command), stub)));
  await Promise.all(["pi", "npm", "git"].map((command) => chmod(join(bin, command), 0o755)));
  const syntaxPassed = await new Promise<boolean>((resolve) => {
    const child = spawn("bash", ["-n", scriptFile]); child.once("close", (code) => resolve(code === 0));
  });
  if (!syntaxPassed) { await rm(root, { recursive: true, force: true }); return { syntaxPassed, invocations: [], paused: false, callsBeforeEnter: 0, output: "", exitCode: 2 }; }

  // Own process group. From lesson 010 a script leaves children of its own —
  // a `tail -f` in a pipeline, a model process and a `sleep` on a fifo — and
  // signalling only Bash leaves them holding the pipe this harness is reading,
  // so `close` never fires and the run hangs until the test times out.
  const child = spawn("bash", [scriptFile, ...(options.args ?? [])], {
    detached: true,
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
    // Bash does not echo `read -p` when stdin is a pipe, so a pause is observed
    // rather than announced. Settling is the first half of the evidence: wait
    // until the turn log has stopped growing for long enough that the script is
    // unlikely to be mid-iteration. Mid-iteration gaps are one process start,
    // well under this window, but it remains a threshold rather than a proof —
    // the Enter below is what confirms it.
    let settledPolls = 0;
    for (let tries = 0; tries < 240 && !exited; tries++) {
      const count = await countPiTurns(log);
      settledPolls = count === callsBeforeEnter ? settledPolls + 1 : 0;
      callsBeforeEnter = count;
      if (settledPolls >= 12) break;
      await wait(25);
    }
    callsBeforeEnter = await countPiTurns(log);
    // Recorded before the Enter is written, because the script moves on after.
    waitingAtEnter = !exited;
  } else {
    // A script with no Enter prompt is expected to finish, so wait for it to,
    // rather than for a fixed slice of wall-clock time: a fixed sleep made
    // every assertion about this script's exit code a race the machine could
    // lose under load. Give up only once the turn log has been quiet far longer
    // than any gap inside a run, which is how a `while true` that asks for
    // nothing is still stopped rather than waited on.
    let quietPolls = 0;
    let seenInvocations = -1;
    for (let tries = 0; tries < 2_400 && !exited; tries++) {
      const count = (await readInvocations(log)).length;
      quietPolls = count === seenInvocations ? quietPolls + 1 : 0;
      seenInvocations = count;
      if (quietPolls >= 80) break;
      await wait(25);
    }
  }

  let reportBeforeEnter: string | undefined;
  if (options.reportPath) {
    try { reportBeforeEnter = await readFile(join(root, options.reportPath), "utf8"); } catch { /* absent until the tee runs */ }
  }

  // The second half of the evidence: only a process actually blocked on `read`
  // resumes when Enter arrives. Spending another turn or finishing is that
  // acknowledgement; a script that had merely gone quiet does neither.
  let resumedOnEnter = false;
  if (pausing) {
    child.stdin.write("\n");
    for (let tries = 0; tries < 60; tries++) {
      if (exited) { resumedOnEnter = waitingAtEnter; break; }
      if (await countPiTurns(log) > callsBeforeEnter) { resumedOnEnter = true; break; }
      await wait(25);
    }
  }
  if (child.pid !== undefined && child.exitCode === null) {
    try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
  }
  const exitCode = await new Promise<number | null>((resolve) => {
    if (child.exitCode !== null) resolve(child.exitCode);
    else child.once("close", (code) => resolve(code));
  });
  let reportAfterEnter: string | undefined;
  if (options.reportPath) {
    try { reportAfterEnter = await readFile(join(root, options.reportPath), "utf8"); } catch { /* absent until the tee runs */ }
  }
  const invocations = await readInvocations(log);
  if (!pausing) callsBeforeEnter = invocations.filter((entry) => entry.command === "pi").length;
  const paused = waitingAtEnter && resumedOnEnter && callsBeforeEnter <= maxPiPerIteration(options.script);
  await rm(root, { recursive: true, force: true });
  return { syntaxPassed, invocations, paused, callsBeforeEnter, output, reportBeforeEnter, reportAfterEnter, exitCode };
}
