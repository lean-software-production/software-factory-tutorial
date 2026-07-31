import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface StubInvocation { command: "pi" | "npm"; args: string[]; cwd: string; stdin: string; }
export interface FactoryStubResult { syntaxPassed: boolean; invocations: StubInvocation[]; paused: boolean; output: string; failureLogBeforeEnter?: string; exitCode: number | null; }

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Exercises factory.sh without giving a real worker access to the kata. The
 * stubs are intentionally tiny shell programs so the test observes pipes,
 * cwd, arguments, and the Enter pause exactly as Bash sees them.
 */
export async function runFactoryWithStubs(factoryScript: string, outcomes: Array<"pass" | "fail"> = ["pass"]): Promise<FactoryStubResult> {
  const root = await mkdtemp(join(tmpdir(), "factory-stub-"));
  const bin = join(root, "bin"); const factory = join(root, "factory"); const calculator = join(root, "calculator"); const log = join(root, "invocations.jsonl");
  await Promise.all([mkdir(bin), mkdir(factory), mkdir(calculator)]);
  await writeFile(join(factory, "factory.sh"), factoryScript);
  await writeFile(join(factory, "refactor.md"), "refactor prompt\n");
  await writeFile(join(factory, "fix-tests.md"), "fix prompt\n");
  const stub = `#!/usr/bin/env node
const fs = require('fs');
const isNpm = process.argv[1].endsWith('npm');
const input = isNpm ? '' : fs.readFileSync(0, 'utf8');
fs.appendFileSync(process.env.EVAL_STUB_LOG, JSON.stringify({command: isNpm ? 'npm' : 'pi', args: process.argv.slice(2), cwd: process.cwd(), stdin: input}) + '\\n');
if (isNpm) { const outcomes = JSON.parse(process.env.EVAL_NPM_OUTCOMES); const n = fs.readFileSync(process.env.EVAL_STUB_LOG, 'utf8').split('\\n').filter(line => line.includes('\\\"npm\\\"')).length - 1; if (outcomes[n] === 'fail') { process.stderr.write('intentional failure\\n'); process.exit(1); } }
`;
  await Promise.all([writeFile(join(bin, "pi"), stub), writeFile(join(bin, "npm"), stub)]);
  await Promise.all([chmod(join(bin, "pi"), 0o755), chmod(join(bin, "npm"), 0o755)]);
  const syntaxPassed = await new Promise<boolean>((resolve) => {
    const child = spawn("bash", ["-n", join(factory, "factory.sh")]); child.once("close", (code) => resolve(code === 0));
  });
  if (!syntaxPassed) { await rm(root, { recursive: true, force: true }); return { syntaxPassed, invocations: [], paused: false, output: "", exitCode: 2 }; }
  const child = spawn("bash", [join(factory, "factory.sh")], {
    cwd: factory,
    env: { PATH: `${bin}:${process.env.PATH ?? ""}`, EVAL_STUB_LOG: log, EVAL_NPM_OUTCOMES: JSON.stringify(outcomes), HOME: root, CI: "1", NO_COLOR: "1" },
    stdio: ["pipe", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.on("data", (data) => { output += String(data); }); child.stderr.on("data", (data) => { output += String(data); });
  // Do not send Enter until all work before the pause has completed. In a
  // recovery factory, an early newline is stdin for the npm stub rather than
  // for Bash's read, which would conceal a real pause defect.
  const expectedBeforePause = factoryScript.includes("npm test") ? 2 : 1;
  let callsBeforeEnter = 0;
  for (let tries = 0; tries < 100; tries++) {
    try { callsBeforeEnter = (await readFile(log, "utf8")).trim().split("\n").filter(Boolean).length; } catch { callsBeforeEnter = 0; }
    if (callsBeforeEnter >= expectedBeforePause) break;
    await wait(25);
  }
  // `read -p` deliberately suppresses its prompt when stdin is a pipe. A
  // second Pi turn before we provide Enter would therefore be the reliable
  // regression signal, not terminal text formatting.
  await wait(25);
  try { callsBeforeEnter = (await readFile(log, "utf8")).trim().split("\n").filter(Boolean).length; } catch { callsBeforeEnter = 0; }
  let failureLogBeforeEnter: string | undefined;
  try { failureLogBeforeEnter = await readFile(join(factory, "test-failure.log"), "utf8"); } catch { /* a passing turn correctly removes it */ }
  child.stdin.write("\n");
  await wait(100);
  child.kill("SIGTERM");
  const exitCode = await new Promise<number | null>((resolve) => child.once("close", (code) => resolve(code)));
  let invocations: StubInvocation[] = [];
  try { invocations = (await readFile(log, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as StubInvocation); } catch { /* no invocation is assertion evidence */ }
  const paused = callsBeforeEnter === expectedBeforePause && invocations.filter((entry) => entry.command === "pi").length >= 2;
  await rm(root, { recursive: true, force: true });
  return { syntaxPassed, invocations, paused, output, failureLogBeforeEnter, exitCode };
}
