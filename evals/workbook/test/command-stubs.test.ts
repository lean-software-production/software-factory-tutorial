import { execFileSync } from "node:child_process";
import { chmod, cp, link, mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { delimiter, dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { createAuthoredCommandStubs, readAuthoredCommandStubEvidence } from "../command-stubs.js";

const tempRoots: string[] = [];
const repoRoot = resolve(import.meta.dirname, "../../..");

function gitPath(): string {
  return execFileSync("/bin/sh", ["-lc", "command -v git"], { encoding: "utf8" }).trim();
}

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
  tempRoots.length = 0;
});

type RunResult = { code: number | null; stdout: string; stderr: string; error?: NodeJS.ErrnoException };

async function tempWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "authored-stubs-workspace-"));
  tempRoots.push(root);
  await mkdir(resolve(root, "calculator"), { recursive: true });
  await cp(resolve(repoRoot, "tutorial/workspaces/refactor-line/calculator"), resolve(root, "calculator"), { recursive: true });
  await mkdir(resolve(root, "factory/refactor/.tmp"), { recursive: true });
  await writeFile(resolve(root, "factory/refactor/success.md"), [
    "# Success",
    "",
    "- passes its tests",
    "- reveals intention",
    "- no duplication",
    "- fewest elements",
    ""
  ].join("\n"));
  return root;
}

async function run(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; input?: string; timeoutMs?: number }): Promise<RunResult> {
  return await new Promise((resolveRun) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolveRun({ code: null, stdout, stderr, error: Object.assign(new Error("timeout"), { code: "TIMEOUT" }) });
    }, options.timeoutMs ?? 5_000);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolveRun({ code: null, stdout, stderr, error });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveRun({ code, stdout, stderr });
    });
    child.stdin.end(options.input ?? "");
  });
}

function jsonl(text: string): any[] {
  return text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as any);
}

function broadEnv(handle: Awaited<ReturnType<typeof createAuthoredCommandStubs>>): NodeJS.ProcessEnv {
  return {
    AUTHORED_EVAL_COMMAND_STUB_CONFIG: handle.hostEnv.AUTHORED_EVAL_COMMAND_STUB_CONFIG,
    AUTHORED_EVAL_NO_NETWORK: "1",
    HOME: handle.hostEnv.HOME,
    TMPDIR: handle.hostEnv.TMPDIR,
    LANG: "C.UTF-8",
    PATH: `${handle.hostBinDir}${delimiter}${dirname(process.execPath)}${delimiter}${dirname(gitPath())}${delimiter}/usr/bin${delimiter}/bin`
  };
}

describe("authored command stubs", () => {
  it("refuses Lesson 001 and materializes under the disposable workspace .tmp mount", async () => {
    const workspace = await tempWorkspace();
    await expect(createAuthoredCommandStubs({ lessonNumber: 1, workspaceRoot: workspace })).rejects.toThrow(/post-Lesson-001/);
    await expect(createAuthoredCommandStubs({ lessonNumber: 3, workspaceRoot: resolve(repoRoot, "tutorial/workspaces/refactor-line") })).rejects.toThrow(/source fixtures/);

    const handle = await createAuthoredCommandStubs({ lessonNumber: 3, workspaceRoot: workspace });
    const realWorkspace = await import("node:fs/promises").then(({ realpath }) => realpath(workspace));
    expect(handle.hostStateDir).toBe(resolve(realWorkspace, "factory/.tmp/authored-eval-command-stubs"));
    expect(handle.hostBinDir).toBe(resolve(realWorkspace, "factory/.tmp/authored-eval-command-stubs/bin"));
    expect(handle.workspaceRelativeBinPath).toBe("factory/.tmp/authored-eval-command-stubs/bin");
    expect(handle.containerBinPath).toBe("/workspace/factory/.tmp/authored-eval-command-stubs/bin");
    expect(handle.hostConfigPath.startsWith(realWorkspace)).toBe(false);
    expect(handle.hostContainerConfigPath).toBe(resolve(realWorkspace, "factory/.tmp/authored-eval-command-stubs/container-config.json"));
    expect(handle.containerStateDir).toBe("/workspace/factory/.tmp/authored-eval-command-stubs");
    expect(handle.containerEvidencePath).toBe("/workspace/factory/.tmp/authored-eval-command-stubs/invocations.jsonl");
    expect(handle.containerConfigPath).toBe("/workspace/factory/.tmp/authored-eval-command-stubs/container-config.json");
    expect(handle).not.toHaveProperty("hostShellActivation");
    expect(handle.containerShellActivation).toContain("/workspace/factory/.tmp/authored-eval-command-stubs/bin'");
    expect(handle.containerShellActivation).toContain(":\"$PATH\"");
    await expect(stat(resolve(handle.hostBinDir, "pi"))).resolves.toBeDefined();
    await expect(stat(resolve(handle.hostBinDir, "node"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(resolve(handle.hostStateDir, "state.json"))).rejects.toMatchObject({ code: "ENOENT" });

    const hostConfig = JSON.parse(await readFile(handle.hostConfigPath, "utf8")) as any;
    const containerConfig = JSON.parse(await readFile(handle.hostContainerConfigPath, "utf8")) as any;
    expect(hostConfig).toMatchObject({ runtime: "host", workspaceRoot: realWorkspace, stateDir: handle.hostStateDir, evidencePath: handle.hostEvidencePath });
    expect(containerConfig).toMatchObject({ runtime: "container", workspaceRoot: "/workspace", stateDir: handle.containerStateDir, evidencePath: handle.containerEvidencePath });
    expect(JSON.stringify(containerConfig)).not.toContain(realWorkspace);
    expect(JSON.stringify(containerConfig)).not.toContain("/private/var");
    expect(handle.hostEnv.AUTHORED_EVAL_COMMAND_STUB_CONFIG).toBe(handle.hostConfigPath);
  });

  it("returns a minimal host env with no credentials and no broad host tools", async () => {
    const workspace = await tempWorkspace();
    const originalSecret = process.env.OPENCODE_API_KEY;
    const originalProxy = process.env.HTTPS_PROXY;
    process.env.OPENCODE_API_KEY = "arbitrary-host-secret";
    process.env.HTTPS_PROXY = "http://proxy-secret.invalid";
    try {
      const handle = await createAuthoredCommandStubs({ lessonNumber: 4, workspaceRoot: workspace });
      const serializedEnv = JSON.stringify(handle.hostEnv);
      expect(serializedEnv).not.toContain("arbitrary-host-secret");
      expect(serializedEnv).not.toContain("proxy-secret");
      expect(handle.hostEnv.HOME).not.toBe(process.env.HOME);
      expect(Object.keys(handle.hostEnv).sort()).toEqual(["AUTHORED_EVAL_COMMAND_STUB_CONFIG", "AUTHORED_EVAL_NO_NETWORK", "HOME", "LANG", "PATH", "TMPDIR", "npm_config_audit", "npm_config_cache", "npm_config_fund", "npm_config_ignore_scripts", "npm_config_offline", "npm_config_update_notifier", "npm_config_yes"]);
      expect(handle.hostEnv.PATH?.split(delimiter)).toEqual([handle.hostBinDir, dirname(process.execPath)]);

      for (const command of ["curl", "git"]) {
        const result = await run(command, ["--version"], { cwd: workspace, env: handle.hostEnv });
        expect(result.error?.code).toBe("ENOENT");
      }
      const npx = await run("npx", ["--version"], { cwd: workspace, env: handle.hostEnv });
      expect(npx).toMatchObject({ code: 0 });
      expect(npx.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
      const missingNpx = await run("npx", ["definitely-missing-authored-eval-package-xyz", "--version"], { cwd: workspace, env: handle.hostEnv, timeoutMs: 10_000 });
      expect(missingNpx.code).not.toBe(0);
      expect(`${missingNpx.stdout}\n${missingNpx.stderr}`).toMatch(/offline|not found|could not determine executable|ENOTCACHED|404/i);

      const calculator = resolve(workspace, "calculator");
      await expect(run("pi", ["--no-session", "--tools", "read,grep,find,ls", "-p"], { cwd: calculator, env: handle.hostEnv, input: "validate" }))
        .resolves.toMatchObject({ code: 0 });
      await expect(run("npm", ["test"], { cwd: calculator, env: handle.hostEnv }))
        .resolves.toMatchObject({ code: 0, stdout: expect.stringContaining("without network") });
    } finally {
      if (originalSecret === undefined) delete process.env.OPENCODE_API_KEY;
      else process.env.OPENCODE_API_KEY = originalSecret;
      if (originalProxy === undefined) delete process.env.HTTPS_PROXY;
      else process.env.HTTPS_PROXY = originalProxy;
    }
  });

  it("records only structural public evidence for arbitrary prompt, output, and steer secrets", async () => {
    const workspace = await tempWorkspace();
    const handle = await createAuthoredCommandStubs({ lessonNumber: 4, workspaceRoot: workspace });
    const calculator = resolve(workspace, "calculator");
    const secret = "ARBITRARY_SECRET_prompt_token_12345 don't leak me";

    const doer = await run("pi", ["--no-session", "--tools", "read,edit,write,grep,find,ls", "-p"], { cwd: calculator, env: handle.hostEnv, input: secret });
    expect(doer.code).toBe(0);
    expect(doer.stdout).not.toContain(secret);
    const validator = await run("pi", ["--no-session", "--tools", "read,grep,find,ls,bash", "-p"], { cwd: calculator, env: handle.hostEnv, input: `baseline includes ${secret}` });
    expect(validator.stdout).toMatch(/^VERDICT: FAIL/);
    const repair = await run("pi", ["--no-session", "--tools", "read,edit,write,grep,find,ls", "-p"], { cwd: calculator, env: handle.hostEnv, input: validator.stdout });
    expect(repair.code).toBe(0);
    const passingValidator = await run("pi", ["--no-session", "--tools", "read,grep,find,ls,bash", "-p"], { cwd: calculator, env: handle.hostEnv, input: "Findings reported by: eslint.\n- calculator/src/index.ts duplicated operator branch parser\n" });
    expect(passingValidator.stdout).toMatch(/^VERDICT: PASS/);

    const evidenceText = await readFile(handle.hostEvidencePath, "utf8");
    expect(evidenceText).not.toContain(secret);
    expect(evidenceText).not.toMatch(/firstLine|rawArgv|timestamp|token_12345|don't leak me/);
    const evidence = await readAuthoredCommandStubEvidence(handle.hostEvidencePath);
    for (const entry of evidence) {
      expect(entry).not.toHaveProperty("at");
      expect(entry).not.toHaveProperty("command");
      expect(entry.output).not.toHaveProperty("firstLine");
    }
    expect(evidence).toEqual([
      expect.objectContaining({ kind: "pi", accepted: true, cwd: "calculator", mode: "text", tools: "read,edit,write,grep,find,ls", station: "doer", mutation: "partial-refactor", prompt: expect.objectContaining({ bytes: expect.any(Number), sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }) }),
      expect.objectContaining({ kind: "pi", accepted: true, cwd: "calculator", mode: "text", tools: "read,grep,find,ls,bash", station: "validator", verdict: "FAIL", mutation: "none" }),
      expect.objectContaining({ kind: "pi", accepted: true, cwd: "calculator", mode: "text", tools: "read,edit,write,grep,find,ls", station: "repair", mutation: "complete-refactor" }),
      expect.objectContaining({ kind: "pi", accepted: true, cwd: "calculator", mode: "text", tools: "read,grep,find,ls,bash", station: "validator", verdict: "PASS", mutation: "none" })
    ]);
  });

  it("rejects tampered evidence instead of returning raw extra fields", async () => {
    const workspace = await tempWorkspace();
    const handle = await createAuthoredCommandStubs({ lessonNumber: 4, workspaceRoot: workspace });
    const tampered = resolve(handle.hostStateDir, "tampered.jsonl");
    await writeFile(tampered, `${JSON.stringify({
      namespace: "evals/workbook/authored-workbook/command-stubs",
      owner: "authored-eval",
      schemaVersion: 1,
      kind: "pi",
      accepted: true,
      cwd: "calculator",
      mode: "text",
      tools: "read,grep,find,ls",
      station: "validator",
      prompt: { bytes: 1, sha256: "a".repeat(64), signals: [] },
      output: { bytes: 1, sha256: "b".repeat(64), eventClasses: ["text"] },
      rawSecretText: "SECRET_SHOULD_NOT_REACH_PUBLIC_EVIDENCE"
    })}\n`);

    await expect(readAuthoredCommandStubEvidence(tampered)).rejects.toThrow(/UNKNOWN_KEY/);
    await expect(readAuthoredCommandStubEvidence(tampered)).rejects.not.toThrow(/SECRET_SHOULD_NOT_REACH_PUBLIC_EVIDENCE|rawSecretText/);
    await writeFile(tampered, `${JSON.stringify({ namespace: "evals/workbook/authored-workbook/command-stubs", owner: "authored-eval", schemaVersion: 1, kind: "pi", accepted: true, cwd: "/absolute", output: { bytes: 1, sha256: "b".repeat(64), eventClasses: ["text"] } })}\n`);
    await expect(readAuthoredCommandStubEvidence(tampered)).rejects.toThrow(/CWD_INVALID/);
  });

  it("enforces bounds before success-shaped output or successful evidence", async () => {
    const workspace = await tempWorkspace();
    const handle = await createAuthoredCommandStubs({ lessonNumber: 4, workspaceRoot: workspace, maxPromptBytes: 16 });
    const calculator = resolve(workspace, "calculator");

    const oversized = await run("pi", ["--no-session", "--tools", "read,grep,find,ls", "-p"], { cwd: calculator, env: handle.hostEnv, input: "x".repeat(17) });
    expect(oversized.code).toBe(1);
    expect(oversized.stdout).toBe("");
    expect(oversized.stderr).toContain("PROMPT_TOO_LARGE");

    const rpcOversized = await run("pi", ["--no-session", "--mode", "rpc", "--tools", "read,edit,write,grep,find,ls"], {
      cwd: calculator,
      env: handle.hostEnv,
      input: `${JSON.stringify({ type: "prompt", message: "x".repeat(17) })}\n`
    });
    expect(rpcOversized.code).toBe(1);
    expect(rpcOversized.stdout).toBe("");
    expect(rpcOversized.stderr).toContain("RPC_PROMPT_TOO_LARGE");

    const evidence = await readAuthoredCommandStubEvidence(handle.hostEvidencePath);
    expect(evidence).toEqual([
      expect.objectContaining({ accepted: false, rejectionCode: "PROMPT_TOO_LARGE" }),
      expect.objectContaining({ accepted: false, rejectionCode: "RPC_PROMPT_TOO_LARGE" })
    ]);
  });

  it("rejects unsafe Pi tools, npm commands, and paths", async () => {
    const workspace = await tempWorkspace();
    const handle = await createAuthoredCommandStubs({ lessonNumber: 6, workspaceRoot: workspace });
    const calculator = resolve(workspace, "calculator");

    await expect(run("pi", ["--tools", "read,grep,find,ls", "-p"], { cwd: calculator, env: handle.hostEnv, input: "short" }))
      .resolves.toMatchObject({ code: 1, stderr: expect.stringContaining("PI_NO_SESSION_REQUIRED") });
    await expect(run("pi", ["--no-session", "--tools", "read,edit,write,grep,find,ls,bash", "-p"], { cwd: calculator, env: handle.hostEnv, input: "unsafe tools" }))
      .resolves.toMatchObject({ code: 1, stderr: expect.stringContaining("PI_TOOLS_NOT_ALLOWLISTED") });
    await expect(run("pi", ["--no-session", "--tools", "read,grep,find,ls,bash", "-p"], { cwd: calculator, env: handle.hostEnv, input: "bash after lesson six" }))
      .resolves.toMatchObject({ code: 1, stderr: expect.stringContaining("PI_VALIDATOR_BASH_AFTER_LESSON_006") });
    await expect(run("npm", ["install"], { cwd: calculator, env: handle.hostEnv }))
      .resolves.toMatchObject({ code: 1, stderr: expect.stringContaining("NPM_COMMAND_NOT_ALLOWLISTED") });
    await expect(run("npm", ["test"], { cwd: workspace, env: handle.hostEnv }))
      .resolves.toMatchObject({ code: 1, stderr: expect.stringContaining("CWD_NOT_ALLOWED") });

    const outside = await mkdtemp(join(tmpdir(), "authored-stubs-outside-"));
    tempRoots.push(outside);
    await expect(run("pi", ["--no-session", "--tools", "read,grep,find,ls", "-p"], { cwd: outside, env: handle.hostEnv, input: "outside" }))
      .resolves.toMatchObject({ code: 1, stderr: expect.stringContaining("CWD_OUTSIDE_WORKSPACE") });
  });

  it("removes a stale evidence lock left by a crashed process", async () => {
    const workspace = await tempWorkspace();
    const handle = await createAuthoredCommandStubs({ lessonNumber: 4, workspaceRoot: workspace });
    const staleLock = resolve(handle.hostStateDir, "evidence.lock");
    await mkdir(staleLock);
    const old = new Date(Date.now() - 20_000);
    await utimes(staleLock, old, old);

    const result = await run("npm", ["test"], { cwd: resolve(workspace, "calculator"), env: handle.hostEnv });
    expect(result.code).toBe(0);
    await expect(stat(staleLock)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("supports concurrent invocations with bounded atomic JSONL evidence appends", async () => {
    const workspace = await tempWorkspace();
    const handle = await createAuthoredCommandStubs({ lessonNumber: 4, workspaceRoot: workspace });
    const calculator = resolve(workspace, "calculator");
    const runs = await Promise.all(Array.from({ length: 8 }, (_, index) => run("npm", [index % 2 === 0 ? "test" : "test"], { cwd: calculator, env: handle.hostEnv })));
    expect(runs.every((result) => result.code === 0)).toBe(true);
    const raw = await readFile(handle.hostEvidencePath, "utf8");
    const lines = raw.trim().split("\n");
    expect(lines).toHaveLength(8);
    expect(() => lines.map((line) => JSON.parse(line))).not.toThrow();
    const evidence = await readAuthoredCommandStubEvidence(handle.hostEvidencePath);
    expect(evidence.every((entry) => entry.kind === "npm" && entry.accepted)).toBe(true);
  });

  it("emits exact JSON event classes consumed by authored jq/text_of scripts", async () => {
    const workspace = await tempWorkspace();
    const handle = await createAuthoredCommandStubs({ lessonNumber: 9, workspaceRoot: workspace });
    const env = broadEnv(handle);
    const calculator = resolve(workspace, "calculator");

    await run("pi", ["--no-session", "--tools", "read,edit,write,grep,find,ls", "-p"], { cwd: calculator, env, input: "make a partial refactor" });
    const tests = await run("npm", ["test"], { cwd: calculator, env });
    const diff = await run("git", ["diff", "--", "."], { cwd: calculator, env });
    const prompt = `validate.md\nsuccess.md\n=== QUALITY BEFORE (recorded before the doer ran) ===\nFindings reported by: eslint.\n\n=== QUALITY NOW ===\nFindings reported by: eslint.\n\n=== TESTS ===\n${tests.stdout}\n=== WORKING DIFF ===\n${diff.stdout}`;
    const jsonRun = await run("pi", ["--no-session", "--mode", "json", "--tools", "read,grep,find,ls", "-p"], { cwd: calculator, env, input: prompt });
    expect(jsonRun.code).toBe(0);
    const events = jsonl(jsonRun.stdout);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "tool_execution_start", toolName: "read", args: expect.objectContaining({ path: expect.any(String) }) }),
      expect.objectContaining({ type: "message_update", assistantMessageEvent: expect.objectContaining({ type: "text_delta", delta: expect.any(String) }) }),
      expect.objectContaining({ type: "message_end", message: expect.objectContaining({ usage: { cost: { total: 0 } } }) }),
      expect.objectContaining({ type: "agent_end", messages: [expect.objectContaining({ role: "assistant" })] })
    ]));
    const textOf = events.filter((event) => event.type === "agent_end").flatMap((event) => event.messages).flatMap((message) => message.content).map((content) => content.text).join("\n");
    expect(textOf).toMatch(/^VERDICT: FAIL/);
  });

  it("drives a faithful Lesson 007+ run to a real calculator git commit", async () => {
    const workspace = await tempWorkspace();
    const git = gitPath();
    await run(git, ["init"], { cwd: workspace, env: process.env });
    await run(git, ["config", "user.email", "stub@example.invalid"], { cwd: workspace, env: process.env });
    await run(git, ["config", "user.name", "Authored Stub"], { cwd: workspace, env: process.env });
    await run(git, ["add", "calculator"], { cwd: workspace, env: process.env });
    await run(git, ["commit", "-m", "initial calculator"], { cwd: workspace, env: process.env });

    const handle = await createAuthoredCommandStubs({ lessonNumber: 9, workspaceRoot: workspace });
    const env = broadEnv(handle);
    const line = resolve(workspace, "factory/refactor");
    await writeFile(resolve(line, "run.sh"), `#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p .tmp/events
text_of() { jq -r 'select(.type=="agent_end") | .messages[] | select(.role=="assistant") | .content[]? | select(.type=="text") | .text' "$1"; }
for iteration in 1 2; do
  echo "=== Iteration $iteration of 2 ==="
  echo "Recording quality baseline..."
  if grep -q 'readFirstOperand("by")' ../../calculator/src/index.ts && [ "$(grep -c 'readFirstOperand("by")' ../../calculator/src/index.ts)" -eq 2 ]; then
    printf 'All quality checks passed.\n' > .tmp/quality-before.txt
  else
    printf 'Findings reported by: eslint.\n- calculator/src/index.ts duplicated operator branch parser\n' > .tmp/quality-before.txt
  fi
  echo "Starting doer..."
  cat refactor.md success.md | (cd ../../calculator && pi --no-session --mode json --tools read,edit,write,grep,find,ls -p) > ".tmp/events/$iteration-do.jsonl"
  echo "Gathering evidence..."
  {
    echo "=== QUALITY BEFORE (recorded before the doer ran) ==="
    cat .tmp/quality-before.txt
    echo
    echo "=== QUALITY NOW ==="
    if grep -q 'readFirstOperand("by")' ../../calculator/src/index.ts && [ "$(grep -c 'readFirstOperand("by")' ../../calculator/src/index.ts)" -eq 2 ]; then
      echo "All quality checks passed."
    else
      printf 'Findings reported by: eslint.\n- calculator/src/index.ts duplicated operator branch parser\n'
    fi
    echo
    echo "=== TESTS ==="
    (cd ../../calculator && npm test 2>&1)
    echo
    echo "=== WORKING DIFF ==="
    (cd ../../calculator && git diff -- .)
  } > .tmp/evidence.txt
  echo "Starting validation..."
  cat validate.md success.md .tmp/evidence.txt | (cd ../../calculator && pi --no-session --mode json --tools read,grep,find,ls -p) > ".tmp/events/$iteration-validate.jsonl"
  text_of ".tmp/events/$iteration-validate.jsonl" > .tmp/validate-findings.txt
  verdict=$(grep -m1 -o '^VERDICT: \\(PASS\\|FAIL\\)' .tmp/validate-findings.txt || echo "VERDICT: FAIL")
  if [ "$verdict" = "VERDICT: FAIL" ]; then
    echo "Starting repair..."
    cat repair.md success.md .tmp/validate-findings.txt | (cd ../../calculator && pi --no-session --mode json --tools read,edit,write,grep,find,ls -p) > ".tmp/events/$iteration-repair.jsonl"
  else
    echo "Starting commit..."
    cat commit.md success.md .tmp/validate-findings.txt .tmp/evidence.txt | (cd ../../calculator && pi --no-session --mode json --tools read,grep,find,ls -p) > ".tmp/events/$iteration-commit.jsonl"
    text_of ".tmp/events/$iteration-commit.jsonl" > .tmp/commit-message.txt
    message="$PWD/.tmp/commit-message.txt"
    (cd ../../calculator && git add -- . && git commit -q -F "$message")
  fi
done
`);
    await writeFile(resolve(line, "refactor.md"), "Choose one small behaviour-preserving refactoring.\n");
    await writeFile(resolve(line, "validate.md"), "Report VERDICT and one finding per criterion from the labelled evidence.\n");
    await writeFile(resolve(line, "repair.md"), "Repair the validator findings only.\n");
    await writeFile(resolve(line, "commit.md"), "Write a commit message with a subject line under 72 characters. Emit only the message.\n");
    await chmod(resolve(line, "run.sh"), 0o755);

    const result = await run("/bin/bash", [resolve(line, "run.sh")], { cwd: workspace, env, timeoutMs: 15_000 });
    expect(result).toMatchObject({ code: 0 });
    expect(result.stdout).toContain("Starting repair");
    expect(result.stdout).toContain("Starting commit");
    const log = await run(git, ["log", "--oneline", "-1"], { cwd: workspace, env });
    expect(log.stdout).toContain("Refactor calculator operand parsing");
    const show = await run(git, ["show", "--stat", "--oneline", "HEAD"], { cwd: workspace, env });
    expect(show.stdout).toContain("calculator/src/index.ts");
    expect(await readFile(resolve(workspace, "calculator/src/index.ts"), "utf8")).toContain("readFirstOperand");
  });

  it("models Lesson 012 FIFO lifetime with holder/doer cleanup and redacted real RPC shapes", async () => {
    const workspace = await tempWorkspace();
    const handle = await createAuthoredCommandStubs({ lessonNumber: 12, workspaceRoot: workspace, rpcEarlySteerWindowMs: 80, rpcLateSteerWindowMs: 500 });
    const env = broadEnv(handle);
    const line = resolve(workspace, "factory/refactor");
    const script = resolve(line, "rpc.sh");
    const secretSteer = `Don't touch parser "secret-steer-42"`;
    await writeFile(script, `#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
rm -f control .tmp/rpc.jsonl
mkfifo control
cleanup() {
  [ -n "\${holder:-}" ] && kill "$holder" 2>/dev/null || true
  [ -n "\${doer:-}" ] && kill "$doer" 2>/dev/null || true
  sleep 0.05
  [ -n "\${holder:-}" ] && kill -KILL "$holder" 2>/dev/null || true
  [ -n "\${doer:-}" ] && kill -KILL "$doer" 2>/dev/null || true
  rm -f control
}
trap cleanup EXIT
(cd ../../calculator && pi --no-session --mode rpc --tools read,edit,write,grep,find,ls) < control > .tmp/rpc.jsonl 2> .tmp/rpc.err &
doer=$!
sleep infinity > control 2>/dev/null &
holder=$!
node -e 'process.stdout.write(JSON.stringify({id:"prompt-1",type:"prompt",message:process.argv[1]})+"\\n")' "$(cat refactor.md success.md)" > control
sleep 0.03
node -e 'process.stdout.write(JSON.stringify({id:"steer-early",type:"steer",message:process.argv[1]})+"\\n")' "$1" > control
sleep 0.25
node -e 'process.stdout.write(JSON.stringify({id:"steer-late",type:"steer",message:process.argv[1]})+"\\n")' "$2" > control
deadline=$((SECONDS + 8))
until grep -q '"type":"agent_end"' .tmp/rpc.jsonl 2>/dev/null; do
  if [ "$SECONDS" -ge "$deadline" ]; then echo "timed out waiting for agent_end" >&2; exit 10; fi
  sleep 0.05
done
if ! kill -0 "$doer" 2>/dev/null; then echo "doer exited before FIFO holder cleanup" >&2; exit 11; fi
echo "doer alive after agent_end"
cleanup
trap - EXIT
exit 0
`);
    await writeFile(resolve(line, "refactor.md"), "Choose one refactoring.\n");
    await chmod(script, 0o755);

    const result = await run("/bin/bash", [script, secretSteer, "late steer with quotes ' and \""], { cwd: workspace, env, timeoutMs: 10_000 });
    expect(result).toMatchObject({ code: 0, stdout: expect.stringContaining("doer alive after agent_end") });
    const eventsText = await readFile(resolve(line, ".tmp/rpc.jsonl"), "utf8");
    expect(eventsText).not.toContain(secretSteer);
    expect(eventsText).not.toContain("secret-steer-42");
    const events = jsonl(eventsText);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "response", id: "prompt-1", command: "prompt", success: true }),
      expect.objectContaining({ type: "response", id: "steer-early", command: "steer", success: true }),
      expect.objectContaining({ type: "response", id: "steer-late", command: "steer", success: true }),
      expect.objectContaining({ type: "queue_update", steering: ["[authored-eval redacted queued message]"], followUp: [] }),
      expect.objectContaining({ type: "tool_execution_start", toolCallId: expect.stringMatching(/^call_authored_rpc_/), toolName: "read", args: { path: "src/index.ts" } }),
      expect.objectContaining({ type: "message_update", assistantMessageEvent: expect.objectContaining({ type: "text_delta", contentIndex: 0 }) }),
      expect.objectContaining({ type: "agent_end", messages: [expect.objectContaining({ role: "assistant" })], willRetry: false })
    ]));
    await expect(stat(resolve(line, "control"))).rejects.toMatchObject({ code: "ENOENT" });
    const evidence = await readAuthoredCommandStubEvidence(handle.hostEvidencePath);
    const rpcEntry = evidence.find((entry) => entry.mode === "rpc");
    expect(rpcEntry).toEqual(expect.objectContaining({ rpc: expect.objectContaining({ earlySteerCount: 1, lateSteerCount: 1, steerBytes: expect.any(Number), steerSha256: expect.stringMatching(/^[a-f0-9]{64}$/) }) }));
    expect(rpcEntry?.output?.sha256).toBe(createHash("sha256").update(eventsText).digest("hex"));
    expect(rpcEntry?.output?.bytes).toBe(Buffer.byteLength(eventsText, "utf8"));
    expect(JSON.stringify(evidence)).not.toContain("secret-steer-42");
  }, 15_000);

  it("rejects fabricated labelled validator evidence and passes only corroborated complete evidence", async () => {
    const workspace = await tempWorkspace();
    const git = gitPath();
    await run(git, ["init"], { cwd: workspace, env: process.env });
    await run(git, ["config", "user.email", "stub@example.invalid"], { cwd: workspace, env: process.env });
    await run(git, ["config", "user.name", "Authored Stub"], { cwd: workspace, env: process.env });
    await run(git, ["add", "calculator"], { cwd: workspace, env: process.env });
    await run(git, ["commit", "-m", "initial calculator"], { cwd: workspace, env: process.env });
    const handle = await createAuthoredCommandStubs({ lessonNumber: 9, workspaceRoot: workspace });
    const env = broadEnv(handle);
    const calculator = resolve(workspace, "calculator");

    await run("pi", ["--no-session", "--tools", "read,edit,write,grep,find,ls", "-p"], { cwd: calculator, env, input: "refactor" });
    await run("pi", ["--no-session", "--tools", "read,edit,write,grep,find,ls", "-p"], { cwd: calculator, env, input: "VERDICT: FAIL repair.md" });
    const tests = await run("npm", ["test"], { cwd: calculator, env });
    const diff = await run(git, ["diff", "--", "."], { cwd: calculator, env });
    const prefix = `validate.md\n=== QUALITY BEFORE ===\nFindings reported by: eslint.\n- calculator/src/index.ts duplicated operator branch parser\n\n=== QUALITY NOW ===\nAll quality checks passed.\n\n=== TESTS ===\n${tests.stdout}\n=== WORKING DIFF ===\n`;

    const fabricated = await run("pi", ["--no-session", "--mode", "json", "--tools", "read,grep,find,ls", "-p"], { cwd: calculator, env, input: `${prefix}diff --git a/calculator/src/index.ts b/calculator/src/index.ts\n+ shallow readFirstOperand marker only\n` });
    expect(fabricated.stdout).toContain("VERDICT: FAIL");

    const corroborated = await run("pi", ["--no-session", "--mode", "json", "--tools", "read,grep,find,ls", "-p"], { cwd: calculator, env, input: `${prefix}${diff.stdout}` });
    expect(corroborated.stdout).toContain("VERDICT: PASS");
  });

  it("detects multiply and divide completion independently when both separators are 'by'", async () => {
    const workspace = await tempWorkspace();
    const handle = await createAuthoredCommandStubs({ lessonNumber: 9, workspaceRoot: workspace });
    const env = broadEnv(handle);
    const calculator = resolve(workspace, "calculator");
    await run("pi", ["--no-session", "--tools", "read,edit,write,grep,find,ls", "-p"], { cwd: calculator, env, input: "partial refactor" });
    const sourcePath = resolve(calculator, "src/index.ts");
    const source = await readFile(sourcePath, "utf8");
    await writeFile(sourcePath, source.replace(
      "    if (word === \"multiply\") {\n      const first = read();\n      if (pieces[place++] !== \"by\") fail();\n      const second = read();\n      return first * second;\n    }",
      "    if (word === \"multiply\") {\n      const first = readFirstOperand(\"by\");\n      const second = read();\n      return first * second;\n    }"
    ));
    const fakeCompleteEvidence = `=== QUALITY BEFORE ===\nFindings reported by: eslint.\n- calculator/src/index.ts duplicated operator branch parser\n\n=== QUALITY NOW ===\nAll quality checks passed.\n\n=== TESTS ===\nauthored-eval npm test stub: calculator tests passed without network.\n\n=== WORKING DIFF ===\n+    const readFirstOperand = (separator: \"and\" | \"from\" | \"by\"): number => {\n+      const first = readFirstOperand(\"and\");\n+      const first = readFirstOperand(\"from\");\n+      const first = readFirstOperand(\"by\");\n+      const first = readFirstOperand(\"by\");\n-      const first = read();\n-      const first = read();\n-      const first = read();\n-      const first = read();\n-      if (pieces[place++] !== \"and\") fail();\n-      if (pieces[place++] !== \"from\") fail();\n-      if (pieces[place++] !== \"by\") fail();\n-      if (pieces[place++] !== \"by\") fail();\n`;
    const result = await run("pi", ["--no-session", "--tools", "read,grep,find,ls", "-p"], { cwd: calculator, env, input: fakeCompleteEvidence });
    expect(result.stdout).toMatch(/^VERDICT: FAIL/);
  });

  it("leaves source byte-identical when complete repair anchors are missing", async () => {
    const workspace = await tempWorkspace();
    const handle = await createAuthoredCommandStubs({ lessonNumber: 9, workspaceRoot: workspace });
    const env = broadEnv(handle);
    const calculator = resolve(workspace, "calculator");
    await run("pi", ["--no-session", "--tools", "read,edit,write,grep,find,ls", "-p"], { cwd: calculator, env, input: "partial refactor" });
    const sourcePath = resolve(calculator, "src/index.ts");
    const beforeCorruption = await readFile(sourcePath, "utf8");
    const corrupted = beforeCorruption.replace("if (pieces[place++] !== \"by\") fail();\n      const second = read();\n      if (second === 0) fail();", "if (pieces[place++] !== \"over\") fail();\n      const second = read();\n      if (second === 0) fail();");
    await writeFile(sourcePath, corrupted);
    const repair = await run("pi", ["--no-session", "--tools", "read,edit,write,grep,find,ls", "-p"], { cwd: calculator, env, input: "VERDICT: FAIL repair.md" });
    expect(repair).toMatchObject({ code: 1, stderr: expect.stringContaining("SOURCE_ANCHOR_MISSING") });
    expect(await readFile(sourcePath, "utf8")).toBe(corrupted);
    const evidence = await readAuthoredCommandStubEvidence(handle.hostEvidencePath);
    expect(evidence.at(-1)).toEqual(expect.objectContaining({ accepted: false, rejectionCode: "SOURCE_ANCHOR_MISSING" }));
  });

  it("refuses symlinked workspace paths without writing or deleting outside the workspace", async () => {
    const workspace = await tempWorkspace();
    const outside = await mkdtemp(join(tmpdir(), "authored-stubs-outside-"));
    tempRoots.push(outside);
    await symlink(outside, resolve(workspace, "factory/.tmp"));
    await expect(createAuthoredCommandStubs({ lessonNumber: 3, workspaceRoot: workspace })).rejects.toThrow(/factory\/\.tmp|real directory/);
    await expect(stat(resolve(outside, "authored-eval-command-stubs"))).rejects.toMatchObject({ code: "ENOENT" });

    const workspace2 = await tempWorkspace();
    const outside2 = await mkdtemp(join(tmpdir(), "authored-stubs-outside-"));
    tempRoots.push(outside2);
    await mkdir(resolve(workspace2, "factory/.tmp"), { recursive: true });
    await symlink(outside2, resolve(workspace2, "factory/.tmp/authored-eval-command-stubs"));
    await expect(createAuthoredCommandStubs({ lessonNumber: 3, workspaceRoot: workspace2 })).rejects.toThrow(/state dir|real directory/);
    expect(await stat(outside2)).toBeDefined();
  });

  it("sanitizes config failures without raw paths, content, or Node stacks", async () => {
    const workspace = await tempWorkspace();
    const handle = await createAuthoredCommandStubs({ lessonNumber: 4, workspaceRoot: workspace });
    const calculator = resolve(workspace, "calculator");
    const pi = resolve(handle.hostBinDir, "pi");
    const baseEnv = { ...handle.hostEnv };
    delete baseEnv.AUTHORED_EVAL_COMMAND_STUB_CONFIG;
    const missing = await run(pi, ["--no-session", "--tools", "read,grep,find,ls", "-p"], { cwd: calculator, env: baseEnv, input: "x" });
    expect(missing).toMatchObject({ code: 78, stderr: expect.stringContaining("MISSING_CONFIG") });

    const badConfig = resolve(workspace, "factory/.tmp/bad-config.json");
    await writeFile(badConfig, `{ "namespace": "SECRET_CONFIG_VALUE" `);
    const malformed = await run(pi, ["--no-session", "--tools", "read,grep,find,ls", "-p"], { cwd: calculator, env: { ...handle.hostEnv, AUTHORED_EVAL_COMMAND_STUB_CONFIG: badConfig }, input: "x" });
    expect(malformed).toMatchObject({ code: 78, stderr: expect.stringContaining("CONFIG_INVALID") });
    expect(malformed.stderr).not.toMatch(/SECRET_CONFIG_VALUE|SyntaxError|at .*command-stubs|bad-config/);

    const unreadable = await run(pi, ["--no-session", "--tools", "read,grep,find,ls", "-p"], { cwd: calculator, env: { ...handle.hostEnv, AUTHORED_EVAL_COMMAND_STUB_CONFIG: resolve(workspace, "factory/.tmp/missing-secret-path.json") }, input: "x" });
    expect(unreadable).toMatchObject({ code: 78, stderr: expect.stringContaining("CONFIG_UNREADABLE") });
    expect(unreadable.stderr).not.toContain("missing-secret-path");

    const sourceBefore = await readFile(resolve(calculator, "src/index.ts"), "utf8");
    const config = JSON.parse(await readFile(handle.hostConfigPath, "utf8")) as any;
    config.stateDir = resolve(workspace, "calculator");
    config.evidencePath = resolve(workspace, "factory/refactor/success.md");
    await writeFile(handle.hostConfigPath, `${JSON.stringify(config, null, 2)}\n`);
    const unsafeConfig = await run(pi, ["--no-session", "--tools", "read,edit,write,grep,find,ls", "-p"], { cwd: calculator, env: handle.hostEnv, input: "refactor" });
    expect(unsafeConfig).toMatchObject({ code: 78, stdout: "", stderr: expect.stringContaining("CONFIG_INVALID") });
    expect(await readFile(resolve(calculator, "src/index.ts"), "utf8")).toBe(sourceBefore);
  });

  it("bounds and sanitizes evidence reading for malformed JSON, huge arrays, and huge files", async () => {
    const workspace = await tempWorkspace();
    const handle = await createAuthoredCommandStubs({ lessonNumber: 4, workspaceRoot: workspace });
    const tampered = resolve(handle.hostStateDir, "tampered-bounds.jsonl");
    await writeFile(tampered, `{ "secret": "RAW_SECRET_SHOULD_NOT_LEAK"\n`);
    await expect(readAuthoredCommandStubEvidence(tampered)).rejects.toThrow(/JSON_PARSE_FAILED/);
    await expect(readAuthoredCommandStubEvidence(tampered)).rejects.not.toThrow(/RAW_SECRET_SHOULD_NOT_LEAK/);

    await writeFile(tampered, `${JSON.stringify({
      namespace: "evals/workbook/authored-workbook/command-stubs",
      owner: "authored-eval",
      schemaVersion: 1,
      kind: "pi",
      accepted: true,
      cwd: "calculator",
      mode: "text",
      tools: "read,grep,find,ls",
      station: "validator",
      verdict: "FAIL",
      mutation: "none",
      prompt: { bytes: 1, sha256: "a".repeat(64), signals: Array.from({ length: 65 }, () => "verdict-fail-feedback") },
      output: { bytes: 1, sha256: "b".repeat(64), eventClasses: ["text"] }
    })}\n`);
    await expect(readAuthoredCommandStubEvidence(tampered)).rejects.toThrow(/ARRAY_INVALID/);

    await writeFile(tampered, "x".repeat(1_000_001));
    await expect(readAuthoredCommandStubEvidence(tampered)).rejects.toThrow(/TOTAL_BYTES_EXCEEDED/);
  });

  it("requires real pre-lesson-006 baseline feedback and complete repaired source", async () => {
    const workspace = await tempWorkspace();
    const handle = await createAuthoredCommandStubs({ lessonNumber: 3, workspaceRoot: workspace });
    const calculator = resolve(workspace, "calculator");
    const partial = await run("pi", ["--no-session", "--tools", "read,edit,write,grep,find,ls", "-p"], { cwd: calculator, env: handle.hostEnv, input: "refactor" });
    expect(partial).toMatchObject({ code: 0 });

    for (const prompt of ["", "looks good", "=== QUALITY NOW ===\nAll quality checks passed.\n"]) {
      const validator = await run("pi", ["--no-session", "--tools", "read,grep,find,ls,bash", "-p"], { cwd: calculator, env: handle.hostEnv, input: prompt });
      expect(validator.stdout).toMatch(/^VERDICT: FAIL/);
    }

    const baseline = "Findings reported by: eslint.\n- calculator/src/index.ts duplicated operator branch parser\n";
    const stillPartial = await run("pi", ["--no-session", "--tools", "read,grep,find,ls,bash", "-p"], { cwd: calculator, env: handle.hostEnv, input: baseline });
    expect(stillPartial.stdout).toMatch(/^VERDICT: FAIL/);
    const repair = await run("pi", ["--no-session", "--tools", "read,edit,write,grep,find,ls", "-p"], { cwd: calculator, env: handle.hostEnv, input: stillPartial.stdout });
    expect(repair).toMatchObject({ code: 0 });
    const repaired = await run("pi", ["--no-session", "--tools", "read,grep,find,ls,bash", "-p"], { cwd: calculator, env: handle.hostEnv, input: baseline });
    expect(repaired.stdout).toMatch(/^VERDICT: PASS/);
  });

  it("requires one non-empty labelled evidence block in canonical order for later lessons", async () => {
    const workspace = await tempWorkspace();
    const git = gitPath();
    await run(git, ["init"], { cwd: workspace, env: process.env });
    await run(git, ["config", "user.email", "stub@example.invalid"], { cwd: workspace, env: process.env });
    await run(git, ["config", "user.name", "Authored Stub"], { cwd: workspace, env: process.env });
    await run(git, ["add", "calculator"], { cwd: workspace, env: process.env });
    await run(git, ["commit", "-m", "initial calculator"], { cwd: workspace, env: process.env });
    const handle = await createAuthoredCommandStubs({ lessonNumber: 9, workspaceRoot: workspace });
    const env = broadEnv(handle);
    const calculator = resolve(workspace, "calculator");
    await run("pi", ["--no-session", "--tools", "read,edit,write,grep,find,ls", "-p"], { cwd: calculator, env, input: "partial" });
    await run("pi", ["--no-session", "--tools", "read,edit,write,grep,find,ls", "-p"], { cwd: calculator, env, input: "VERDICT: FAIL repair.md" });
    const tests = await run("npm", ["test"], { cwd: calculator, env });
    const diff = await run(git, ["diff", "--", "."], { cwd: calculator, env });
    const good = `=== QUALITY BEFORE ===\nFindings reported by: eslint.\n- calculator/src/index.ts duplicated operator branch parser\n\n=== QUALITY NOW ===\nAll quality checks passed.\n\n=== TESTS ===\n${tests.stdout}\n=== WORKING DIFF ===\n${diff.stdout}`;
    const reordered = `=== QUALITY NOW ===\nAll quality checks passed.\n\n=== QUALITY BEFORE ===\nFindings reported by: eslint.\n\n=== TESTS ===\n${tests.stdout}\n=== WORKING DIFF ===\n${diff.stdout}`;
    const duplicate = `${good}\n=== TESTS ===\n${tests.stdout}`;
    const empty = good.replace(/=== TESTS ===\n[\s\S]*?=== WORKING DIFF ===/, "=== TESTS ===\n\n=== WORKING DIFF ===");
    for (const prompt of [reordered, duplicate, empty]) {
      const result = await run("pi", ["--no-session", "--tools", "read,grep,find,ls", "-p"], { cwd: calculator, env, input: prompt });
      expect(result.stdout).toMatch(/^VERDICT: FAIL/);
    }
    const pass = await run("pi", ["--no-session", "--tools", "read,grep,find,ls", "-p"], { cwd: calculator, env, input: good });
    expect(pass.stdout).toMatch(/^VERDICT: PASS/);
  });

  it("does not mutate source when accepted text or RPC evidence capacity fails", async () => {
    const workspace = await tempWorkspace();
    const handle = await createAuthoredCommandStubs({ lessonNumber: 9, workspaceRoot: workspace, maxEvidenceEntryBytes: 120 });
    const calculator = resolve(workspace, "calculator");
    const sourcePath = resolve(calculator, "src/index.ts");
    const beforeText = await readFile(sourcePath, "utf8");
    const textResult = await run("pi", ["--no-session", "--tools", "read,edit,write,grep,find,ls", "-p"], { cwd: calculator, env: handle.hostEnv, input: "refactor" });
    expect(textResult).toMatchObject({ code: 1, stdout: "", stderr: expect.stringContaining("EVIDENCE_LIMIT_EXCEEDED") });
    expect(await readFile(sourcePath, "utf8")).toBe(beforeText);

    const workspace2 = await tempWorkspace();
    const handle2 = await createAuthoredCommandStubs({ lessonNumber: 12, workspaceRoot: workspace2, maxEvidenceEntryBytes: 120, rpcEarlySteerWindowMs: 20, rpcLateSteerWindowMs: 20 });
    const calculator2 = resolve(workspace2, "calculator");
    const line = resolve(workspace2, "factory/refactor");
    const beforeRpc = await readFile(resolve(calculator2, "src/index.ts"), "utf8");
    const script = resolve(line, "rpc-capacity.sh");
    await writeFile(script, `#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")"
rm -f control .tmp/rpc-capacity.jsonl .tmp/rpc-capacity.err
mkfifo control
cleanup() {
  [ -n "\${holder:-}" ] && kill "$holder" 2>/dev/null || true
  rm -f control
}
trap cleanup EXIT
(cd ../../calculator && pi --no-session --mode rpc --tools read,edit,write,grep,find,ls) < control > .tmp/rpc-capacity.jsonl 2> .tmp/rpc-capacity.err &
doer=$!
sleep infinity > control 2>/dev/null &
holder=$!
node -e 'process.stdout.write(JSON.stringify({type:"prompt",message:"refactor"})+"\\n")' > control
wait "$doer"
status=$?
cat .tmp/rpc-capacity.err >&2
exit "$status"
`);
    await chmod(script, 0o755);
    const rpc = await run("/bin/bash", [script], { cwd: workspace2, env: broadEnv(handle2), timeoutMs: 5_000 });
    expect(rpc).toMatchObject({ code: 1, stderr: expect.stringContaining("EVIDENCE_LIMIT_EXCEEDED") });
    const rpcEvents = await readFile(resolve(line, ".tmp/rpc-capacity.jsonl"), "utf8");
    expect(rpcEvents).not.toContain("agent_end");
    expect(await readFile(resolve(calculator2, "src/index.ts"), "utf8")).toBe(beforeRpc);
  });

  it("rejects evidence symlink and hardlink aliases without appending outside", async () => {
    const workspace = await tempWorkspace();
    const handle = await createAuthoredCommandStubs({ lessonNumber: 4, workspaceRoot: workspace });
    const outside = resolve(await mkdtemp(join(tmpdir(), "authored-stubs-outside-evidence-")), "outside.jsonl");
    tempRoots.push(dirname(outside));
    await writeFile(outside, "outside-original\n");
    await rm(handle.hostEvidencePath);
    await symlink(outside, handle.hostEvidencePath);
    const symlinked = await run("npm", ["test"], { cwd: resolve(workspace, "calculator"), env: handle.hostEnv });
    expect(symlinked).toMatchObject({ code: 1, stderr: expect.stringContaining("RUNTIME_LAYOUT_UNSAFE") });
    expect(await readFile(outside, "utf8")).toBe("outside-original\n");

    const workspace2 = await tempWorkspace();
    const handle2 = await createAuthoredCommandStubs({ lessonNumber: 4, workspaceRoot: workspace2 });
    const outsideHardlink = resolve(await mkdtemp(join(tmpdir(), "authored-stubs-hardlink-")), "hardlink.jsonl");
    tempRoots.push(dirname(outsideHardlink));
    await link(handle2.hostEvidencePath, outsideHardlink);
    await expect(readAuthoredCommandStubEvidence(handle2.hostEvidencePath)).rejects.toThrow(/UNSAFE_FILE/);
    const hardlinkRun = await run("npm", ["test"], { cwd: resolve(workspace2, "calculator"), env: handle2.hostEnv });
    expect(hardlinkRun).toMatchObject({ code: 1, stderr: expect.stringContaining("RUNTIME_LAYOUT_UNSAFE") });
  });

  it("requires a FIFO holder for RPC and bounds excessive steers without mutation", async () => {
    const workspace = await tempWorkspace();
    const handle = await createAuthoredCommandStubs({ lessonNumber: 12, workspaceRoot: workspace, rpcEarlySteerWindowMs: 100, rpcLateSteerWindowMs: 100 });
    const calculator = resolve(workspace, "calculator");
    const sourcePath = resolve(calculator, "src/index.ts");
    const before = await readFile(sourcePath, "utf8");
    const noHolder = await run("pi", ["--no-session", "--mode", "rpc", "--tools", "read,edit,write,grep,find,ls"], { cwd: calculator, env: handle.hostEnv, input: `${JSON.stringify({ id: "p", type: "prompt", message: "refactor" })}\n` });
    expect(noHolder).toMatchObject({ code: 1, stderr: expect.stringContaining("RPC_FIFO_HOLDER_REQUIRED") });
    expect(noHolder.stdout).not.toContain("agent_end");
    expect(await readFile(sourcePath, "utf8")).toBe(before);

    const manySteers = [JSON.stringify({ id: "p2", type: "prompt", message: "refactor" }), ...Array.from({ length: 40 }, (_, index) => JSON.stringify({ id: `s${index}`, type: "steer", message: `secret steer ${index}` }))].join("\n") + "\n";
    const excessive = await run("pi", ["--no-session", "--mode", "rpc", "--tools", "read,edit,write,grep,find,ls"], { cwd: calculator, env: handle.hostEnv, input: manySteers });
    expect(excessive).toMatchObject({ code: 1, stderr: expect.stringContaining("RPC_COMMAND_LIMIT_EXCEEDED") });
    expect(excessive.stdout.length).toBeLessThan(32768);
    expect(excessive.stdout).not.toContain("secret steer");
    expect(excessive.stdout).not.toContain("agent_end");
    expect(await readFile(sourcePath, "utf8")).toBe(before);
  });
});
