import type { ArtifactState, CanonicalPatch, FileExpectation, Scenario } from "../lesson-001/scenarios.js";
import {
  correctDo, correctLineRun, correctValidateSh, doPath, lesson005FinalState, linePath,
  refactor, refactorPath, success, successPath, validate as validate005, validatePath, validateShPath
} from "../lesson-005/scenarios.js";

export const evidencePath = "factory/refactor/evidence.txt";

/**
 * The harness gathers what the validator can no longer run. Indented for the
 * loop body in `run.sh` and flush for `validate.sh`, which is why it is built
 * once and re-indented rather than written twice.
 */
const evidence = (indent: string) => `${indent}echo "Gathering evidence..."
${indent}{
${indent}  echo "=== QUALITY BEFORE (recorded before the doer ran) ==="
${indent}  cat quality-before.txt
${indent}  echo
${indent}  echo "=== QUALITY NOW ==="
${indent}  (cd ../../calculator && node scripts/quality.mjs) || true
${indent}  echo
${indent}  echo "=== TESTS ==="
${indent}  (cd ../../calculator && npm test 2>&1) || true
${indent}  echo
${indent}  echo "=== WORKING DIFF ==="
${indent}  (cd ../../calculator && git diff -- .)
${indent}} > evidence.txt
`;

/** The validator no longer runs anything, so its prompt stops telling it to. */
export const readOnlyValidate = `The success criteria the line is working towards, and the evidence gathered about the change just made, are appended below in labelled sections.

Report whether the change was a single behaviour-preserving refactoring that moves the calculator towards those criteria. Work only from the evidence appended below; you cannot run commands, and nothing else about this change is available to you. Quote what the evidence actually says.

Answer in exactly this format, with the verdict on the first non-empty line:

VERDICT: PASS

FINDINGS:
- [PASS] <success criterion>: <specific evidence>
- [FAIL] <success criterion>: <specific evidence>

The first non-empty line must be exactly \`VERDICT: PASS\` or \`VERDICT: FAIL\`. Give one finding for every criterion appended below. Do not expect one small refactoring to reach the whole destination, and passing tests alone are not a passing verdict.
`;

export const correctReadOnlyValidateSh = `#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
if [ ! -f quality-before.txt ]; then
  echo "No quality baseline. Run ./do.sh first." >&2
  exit 1
fi
${evidence("")}echo "Starting validation..."
cat validate.md success.md evidence.txt \\
  | (cd ../../calculator && pi --no-session --tools read,grep,find,ls -p) \\
  | tee validate-findings.txt
`;

export const correctReadOnlyRun = `#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
while true; do
  echo "Recording quality baseline..."
  (cd ../../calculator && node scripts/quality.mjs) > quality-before.txt || true
  echo "Starting doer..."
  cat refactor.md success.md | (cd ../../calculator && pi --no-session --tools read,edit,write,grep,find,ls -p)
${evidence("  ")}  echo "Starting validation..."
  cat validate.md success.md evidence.txt \\
    | (cd ../../calculator && pi --no-session --tools read,grep,find,ls -p) \\
    | tee validate-findings.txt
  read -r -p "Press Enter for the next iteration, or Ctrl-C to stop. "
done
`;

/** The boundary left as a sentence: `bash` is still there, and the prompt still asks. */
const keptShellRun = correctReadOnlyRun.replace("--tools read,grep,find,ls -p", "--tools read,grep,find,ls,bash -p");
/** Evidence gathered but never handed over, so the prompt defers to nothing. */
const uncarriedEvidenceRun = correctReadOnlyRun.replace("cat validate.md success.md evidence.txt", "cat validate.md success.md");
/** Unlabelled sections: two quality reports the validator cannot tell apart. */
const unlabelledEvidenceRun = correctReadOnlyRun
  .replace(/ {4}echo "=== [A-Z ()a-z]+ ==="\n/g, "")
  .replace(/ {4}echo\n/g, "");

const readOnlyRunExpectations: FileExpectation = {
  exists: true,
  contains: [
    /while true; do/,
    /Gathering evidence/,
    /=== QUALITY BEFORE/,
    /=== QUALITY NOW/,
    /=== TESTS/,
    /=== WORKING DIFF/,
    /git diff -- \./,
    /npm test/,
    /\} > evidence\.txt/,
    /cat validate\.md success\.md evidence\.txt/,
    /--tools read,grep,find,ls -p/,
    /tee validate-findings\.txt/,
    /read -r -p/
  ],
  // The shell is the point: the validator must not be able to run anything.
  excludes: [/read,grep,find,ls,bash/, /\(cd \.\.\/calculator && /]
};

const readOnlyValidateShExpectations: FileExpectation = {
  exists: true,
  contains: [/if \[ ! -f quality-before\.txt \]/, /Gathering evidence/, /git diff -- \./, /cat validate\.md success\.md evidence\.txt/, /--tools read,grep,find,ls -p/],
  excludes: [/read,grep,find,ls,bash/, /\(cd \.\.\/calculator && /]
};

export const lesson006FinalState: ArtifactState = {
  ...lesson005FinalState,
  [validatePath]: {
    exists: true,
    contains: [/VERDICT: PASS/, /VERDICT: FAIL/, /appended below/i, /one finding for every criterion/i, /cannot run commands|you cannot run/i],
    // The old prompt told the validator to run things and forbade it from
    // modifying files. Both belong to a boundary drawn with sentences.
    excludes: [/Run the evidence each criterion names/i, /do not run shell commands that modify files/i]
  },
  [validateShPath]: readOnlyValidateShExpectations,
  [linePath]: readOnlyRunExpectations
};

const contains = (path: string, patterns: RegExp[], excludes: RegExp[] = []): ArtifactState => ({ [path]: { exists: true, contains: patterns, excludes } });

/** What lesson 005 left behind: the whole line, ordered, with a validator that is only asked to behave. */
export const lesson005Seed: Record<string, string> = {
  [refactorPath]: refactor, [validatePath]: validate005, [successPath]: success,
  [doPath]: correctDo, [validateShPath]: correctValidateSh, [linePath]: correctLineRun,
  "factory/refactor/quality-before.txt": "eslint: 3 findings\nknip: 1 finding\n"
};

const promptStep = (): CanonicalPatch => ({
  name: "read-only-prompt", files: { [validatePath]: readOnlyValidate },
  message: "I've rewritten the validator's prompt to work from appended evidence. Please check it.",
  preconditions: { [linePath]: { exists: true }, [validatePath]: { exists: true, contains: [/Run the evidence each criterion names/i] } },
  expectedState: { [validatePath]: lesson006FinalState[validatePath]! }, checkpoint: "guided-step"
});
const harnessStep = (): CanonicalPatch => ({
  name: "gather-evidence", files: { [linePath]: correctReadOnlyRun, [validateShPath]: correctReadOnlyValidateSh },
  message: "I've moved the evidence gathering into the harness and taken bash away from the validator. Please check it.",
  preconditions: { [validatePath]: { exists: true, contains: [/cannot run commands|you cannot run/i] }, [linePath]: { exists: true, contains: [/read,grep,find,ls,bash/] } },
  expectedState: { [linePath]: readOnlyRunExpectations, [validateShPath]: readOnlyValidateShExpectations }, checkpoint: "guided-step"
});

const harnessDefect = (name: "kept-shell" | "uncarried-evidence" | "unlabelled-evidence"): CanonicalPatch => ({
  name: "defect",
  files: {
    [linePath]: name === "kept-shell" ? keptShellRun : name === "uncarried-evidence" ? uncarriedEvidenceRun : unlabelledEvidenceRun,
    [validateShPath]: correctReadOnlyValidateSh
  },
  message: "I've moved the evidence gathering into the harness. Please give feedback.",
  preconditions: { [validatePath]: { exists: true, contains: [/cannot run commands|you cannot run/i] }, [linePath]: { exists: true, contains: [/read,grep,find,ls,bash/] } },
  expectedState: name === "kept-shell"
    ? contains(linePath, [/--tools read,grep,find,ls,bash -p/])
    : name === "uncarried-evidence"
      ? contains(linePath, [/cat validate\.md success\.md \\\n/], [/cat validate\.md success\.md evidence\.txt/])
      : contains(linePath, [/\} > evidence\.txt/], [/=== QUALITY NOW/]),
  checkpoint: "guided-step"
});
const harnessRepair = (broken: CanonicalPatch): CanonicalPatch => ({
  name: "repair", files: { [linePath]: correctReadOnlyRun, [validateShPath]: correctReadOnlyValidateSh },
  message: "I've applied the smallest repair. Please check it.",
  preconditions: broken.expectedState,
  expectedState: { [linePath]: readOnlyRunExpectations }, checkpoint: "correction"
});

const keptShellDefect = harnessDefect("kept-shell");
const uncarriedDefect = harnessDefect("uncarried-evidence");
const unlabelledDefect = harnessDefect("unlabelled-evidence");

export const lesson006Scenarios: Scenario[] = [
  { id: "read-only-agent-led-happy-path", lesson: "006", mode: "delegate", description: "Delegating learner narrows the validator's tools and moves its evidence gathering into the harness.", seed: lesson005Seed, patches: [], finalState: lesson006FinalState },
  { id: "read-only-learner-led-happy-path", lesson: "006", mode: "hands-on", description: "Hands-on learner rewrites the validator's prompt to work from appended evidence, then gathers that evidence in the harness and takes the shell away, one canonical edit at a time.", seed: lesson005Seed, patches: [promptStep(), harnessStep()], finalState: lesson006FinalState },
  { id: "mistake-validator-keeps-its-shell", lesson: "006", mode: "mistake", description: "Hands-on learner gathers the evidence in the harness but leaves `bash` in the validator's toolset.", expectedMistake: "The evidence now arrives appended and the validator can still run anything it likes, so the boundary is still a sentence in a prompt rather than a property of the harness — which is the one thing this lesson exists to change.", seed: lesson005Seed, patches: [promptStep(), keptShellDefect, harnessRepair(keptShellDefect)], finalState: lesson006FinalState },
  { id: "mistake-evidence-never-handed-over", lesson: "006", mode: "mistake", description: "Hands-on learner writes `evidence.txt` but does not append it to the validator's prompt.", expectedMistake: "The prompt defers to evidence appended below and nothing is appended, so a validator that can no longer gather anything itself is asked to report on a change it cannot see.", seed: lesson005Seed, patches: [promptStep(), uncarriedDefect, harnessRepair(uncarriedDefect)], finalState: lesson006FinalState },
  { id: "mistake-evidence-sections-unlabelled", lesson: "006", mode: "mistake", description: "Hands-on learner concatenates the evidence without its section headers.", expectedMistake: "Two of the blocks are quality reports, so without labels the validator cannot tell the baseline from the current state and has no way to say whether anything improved.", seed: lesson005Seed, patches: [promptStep(), unlabelledDefect, harnessRepair(unlabelledDefect)], finalState: lesson006FinalState }
];
