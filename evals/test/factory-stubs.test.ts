import { describe, expect, it } from "vitest";
import { runFactoryWithStubs } from "../harness/factory-stubs.js";

const doerScript = `#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
echo "Recording quality baseline..."
(cd ../calculator && node scripts/quality.mjs) > refactor-quality-before.txt || true
echo "Starting doer..."
cat refactor.md | (cd ../calculator && pi --no-session --tools read,edit,write,grep,find,ls -p)
`;

const validatorScript = `#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
if [ ! -f refactor-quality-before.txt ]; then
  echo "No quality baseline. Run ./refactor-do.sh first." >&2
  exit 1
fi
echo "Starting validation..."
cat refactor-validate.md refactor-quality-before.txt \\
  | (cd ../calculator && pi --no-session --tools read,grep,find,ls,bash -p) \\
  | tee refactor-validate-findings.txt
`;

const lineScript = `#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
while true; do
  echo "Recording quality baseline..."
  (cd ../../calculator && node scripts/quality.mjs) > quality-before.txt || true
  echo "Starting doer..."
  cat refactor.md success.md | (cd ../../calculator && pi --no-session --tools read,edit,write,grep,find,ls -p)
  echo "Starting validation..."
  cat validate.md success.md quality-before.txt \\
    | (cd ../../calculator && pi --no-session --tools read,grep,find,ls,bash -p) \\
    | tee validate-findings.txt
  read -r -p "Press Enter for the next iteration, or Ctrl-C to stop. "
done
`;

const repairLineScript = `#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
while true; do
  echo "Recording quality baseline..."
  (cd ../../calculator && node scripts/quality.mjs) > quality-before.txt || true
  echo "Starting doer..."
  cat refactor.md success.md | (cd ../../calculator && pi --no-session --tools read,edit,write,grep,find,ls -p)
  echo "Starting validation..."
  cat validate.md success.md quality-before.txt \\
    | (cd ../../calculator && pi --no-session --tools read,grep,find,ls,bash -p) \\
    | tee validate-findings.txt
  verdict=$(grep -m1 -o '^VERDICT: \\(PASS\\|FAIL\\)' validate-findings.txt || echo "VERDICT: FAIL")
  if [ "$verdict" = "VERDICT: FAIL" ]; then
    echo "Starting repair..."
    cat repair.md success.md validate-findings.txt \\
      | (cd ../../calculator && pi --no-session --tools read,edit,write,grep,find,ls -p)
  fi
  read -r -p "Press Enter for the next iteration, or Ctrl-C to stop. "
done
`;

const pauseFirstScript = `#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
while true; do
  read -r -p "Press Enter to begin the next iteration, or Ctrl-C to stop. "
  echo "Starting doer..."
  cat refactor.md | (cd ../../calculator && pi --no-session --tools read,edit,write,grep,find,ls -p)
done
`;

const runawayScript = `#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
for prompt in refactor validate; do
  cat "$prompt.md" | (cd ../../calculator && pi --no-session --tools read,grep,find,ls -p)
done
read -r -p "Press Enter for the next iteration, or Ctrl-C to stop. "
`;

const linePrompts = {
  "factory/refactor/refactor.md": "refactor prompt\n",
  "factory/refactor/validate.md": "validate prompt\n",
  "factory/refactor/success.md": "success prompt\n",
  "factory/refactor/repair.md": "repair prompt\n"
};

describe("runFactoryWithStubs", () => {
  it("runs a one-shot doer script to completion", async () => {
    const result = await runFactoryWithStubs({
      scriptPath: "factory/refactor-do.sh",
      script: doerScript,
      files: { "factory/refactor.md": "refactor prompt\n" }
    });

    expect(result.syntaxPassed).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.paused).toBe(false);
    const pi = result.invocations.filter((entry) => entry.command === "pi");
    expect(pi).toHaveLength(1);
    expect(pi[0]!.stdin).toContain("refactor prompt");
    expect(pi[0]!.cwd.endsWith("/calculator")).toBe(true);
    expect(result.output).toContain("Recording quality baseline...");
  });

  it("captures a teed validator report", async () => {
    const result = await runFactoryWithStubs({
      scriptPath: "factory/refactor-validate.sh",
      script: validatorScript,
      files: {
        "factory/refactor-validate.md": "validate prompt\n",
        "factory/refactor-quality-before.txt": "quality baseline\n"
      },
      validatorOutputs: ["VERDICT: FAIL\n\nEVIDENCE:\n- quality got worse\n"],
      reportPath: "factory/refactor-validate-findings.txt"
    });

    expect(result.exitCode).toBe(0);
    expect(result.reportAfterEnter).toContain("VERDICT: FAIL");
  });

  it("stops at the missing baseline guard before spending a turn", async () => {
    const result = await runFactoryWithStubs({
      scriptPath: "factory/refactor-validate.sh",
      script: validatorScript,
      files: { "factory/refactor-validate.md": "validate prompt\n" },
      reportPath: "factory/refactor-validate-findings.txt"
    });

    expect(result.syntaxPassed).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(result.invocations).toEqual([]);
    expect(result.output).toContain("No quality baseline.");
    expect(result.reportAfterEnter).toBeUndefined();
  });

  it("stops a loop that never asks for Enter instead of waiting on it forever", async () => {
    const result = await runFactoryWithStubs({
      scriptPath: "factory/refactor/run.sh",
      script: "#!/usr/bin/env bash\nset -euo pipefail\n\nwhile true; do sleep 0.2; done\n",
      files: {}
    });

    expect(result.syntaxPassed).toBe(true);
    expect(result.paused).toBe(false);
    expect(result.exitCode).not.toBe(0);
  }, 5000);

  it("reports a syntax error without running anything", async () => {
    const result = await runFactoryWithStubs({
      scriptPath: "factory/refactor-do.sh",
      script: "if true; then\n",
      files: {}
    });

    expect(result.syntaxPassed).toBe(false);
    expect(result.invocations).toEqual([]);
  });

  it("pauses a nested line after one iteration of doer and validator", async () => {
    const result = await runFactoryWithStubs({
      scriptPath: "factory/refactor/run.sh",
      script: lineScript,
      files: linePrompts,
      reportPath: "factory/refactor/validate-findings.txt"
    });

    expect(result.syntaxPassed).toBe(true);
    expect(result.paused).toBe(true);
    const pi = result.invocations.filter((entry) => entry.command === "pi");
    expect(pi[0]!.stdin).toContain("refactor prompt");
    expect(pi[0]!.cwd.endsWith("/calculator")).toBe(true);
    expect(pi[1]!.stdin).toContain("validate prompt");
    expect(result.reportBeforeEnter).toContain("VERDICT: PASS");
  });

  it("sees a pause taken before the first turn of the iteration", async () => {
    const result = await runFactoryWithStubs({
      scriptPath: "factory/refactor/run.sh",
      script: pauseFirstScript,
      files: linePrompts
    });

    expect(result.paused).toBe(true);
    expect(result.callsBeforeEnter).toBe(0);
    expect(result.invocations.some((entry) => entry.stdin.includes("refactor prompt"))).toBe(true);
  });

  it("refuses to call a run that outspent its iteration a pause", async () => {
    const result = await runFactoryWithStubs({
      scriptPath: "factory/refactor/run.sh",
      script: runawayScript,
      files: linePrompts
    });

    expect(result.callsBeforeEnter).toBe(2);
    expect(result.paused).toBe(false);
  });

  it("pauses a line whose failed verdict adds a repair turn to the same iteration", async () => {
    const result = await runFactoryWithStubs({
      scriptPath: "factory/refactor/run.sh",
      script: repairLineScript,
      files: linePrompts,
      validatorOutputs: ["VERDICT: FAIL\n\nEVIDENCE:\n- quality got worse\n"],
      reportPath: "factory/refactor/validate-findings.txt"
    });

    expect(result.syntaxPassed).toBe(true);
    expect(result.paused).toBe(true);
    expect(result.reportBeforeEnter).toContain("VERDICT: FAIL");
    expect(result.output).toContain("Starting repair...");
    const pi = result.invocations.filter((entry) => entry.command === "pi");
    expect(pi.some((entry) => entry.stdin.includes("repair prompt"))).toBe(true);
  });
});
