import type { ArtifactState, CanonicalPatch, FileExpectation, Scenario } from "../lesson-001/scenarios.js";
import { correctRun as partOneDo, refactor as partOneRefactor, refactorPath as partOneRefactorPath, runPath as partOneDoPath } from "../lesson-002/scenarios.js";
import { correctValidateRun as partOneValidateSh, validate as partOneValidate, validatePath as partOneValidatePath, validateRunPath as partOneValidateShPath } from "../lesson-003/scenarios.js";

/**
 * Lesson 005 moves everything into `factory/refactor/`, drops the `refactor-`
 * prefixes, and adds the criteria both machines now work towards. Every path
 * below is inside the line's own folder, and every script reaches the calculator
 * one directory deeper than it did in Part 1.
 */
export const linePath = "factory/refactor/run.sh";
export const doPath = "factory/refactor/do.sh";
export const validateShPath = "factory/refactor/validate.sh";
export const refactorPath = "factory/refactor/refactor.md";
export const validatePath = "factory/refactor/validate.md";
export const successPath = "factory/refactor/success.md";

export const success = `# Success criteria

These criteria describe where the line is going after many small refactorings. They are not a checklist for the next change, and one refactoring is not expected to reach them.

1. Passes its tests. Evidence: \`npm test\`, run from \`calculator/\`.
2. Reveals intention. Evidence: the diff reads with clearer names, responsibilities, and control flow.
3. No duplication. Evidence: \`grep -n\` putting two near-identical passages side by side with their line numbers.
4. Fewest elements. Evidence: \`node scripts/quality.mjs\`, whose findings name imports, helpers, branches, and abstractions the behaviour does not require.
`;

export const refactor = `Use the success criteria appended below to choose one small, behaviour-preserving refactoring that moves the calculator towards them, and make it.

Edit files directly. Do not run tests, npm, or shell commands. Keep your response concise.
`;

export const validate = `The success criteria the line is working towards, and the quality baseline recorded before this change, are appended below.

Read the working-tree diff in the calculator and report whether the change was a single behaviour-preserving refactoring that moves the calculator towards those criteria. Run the evidence each criterion names and quote what it reported. Do not modify any file, and do not run shell commands that modify files.

Answer in exactly this format, with the verdict on the first non-empty line:

VERDICT: PASS

FINDINGS:
- [PASS] <success criterion>: <specific evidence>
- [FAIL] <success criterion>: <specific evidence>

The first non-empty line must be exactly \`VERDICT: PASS\` or \`VERDICT: FAIL\`. Give one finding for every criterion appended below. Do not expect one small refactoring to reach the whole destination, and passing tests alone are not a passing verdict.
`;

export const correctDo = `#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
echo "Recording quality baseline..."
(cd ../../calculator && node scripts/quality.mjs) > quality-before.txt || true
echo "Starting doer..."
cat refactor.md success.md | (cd ../../calculator && pi --no-session --tools read,edit,write,grep,find,ls -p)
`;

export const correctValidateSh = `#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
if [ ! -f quality-before.txt ]; then
  echo "No quality baseline. Run ./do.sh first." >&2
  exit 1
fi
echo "Starting validation..."
cat validate.md success.md quality-before.txt \\
  | (cd ../../calculator && pi --no-session --tools read,grep,find,ls,bash -p) \\
  | tee validate-findings.txt
`;

export const correctLineRun = `#!/usr/bin/env bash
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

/** The prompts and scripts as they stand immediately after the move, before the criteria exist. */
const relocatedRefactor = `Choose one small, behaviour-preserving refactoring that makes the calculator clearer, and make it.

Edit files directly. Do not run tests, npm, or shell commands. Keep your response concise.
`;
const relocatedValidate = `Read the working-tree diff in the calculator and decide one thing: was the change a single refactoring, and did it reduce what \`node scripts/quality.mjs\` reports compared with the baseline included below?

Run \`node scripts/quality.mjs\` yourself and quote what it reported. Do not modify any file, and do not run shell commands that modify files.

Answer in exactly this format, with the verdict on the first non-empty line:

VERDICT: PASS

EVIDENCE:
- <what you ran, and what it reported>

The first non-empty line must be exactly \`VERDICT: PASS\` or \`VERDICT: FAIL\`.
`;
const relocatedDo = correctDo.replace("cat refactor.md success.md |", "cat refactor.md |");
const relocatedValidateSh = correctValidateSh.replace("cat validate.md success.md quality-before.txt", "cat validate.md quality-before.txt");

/** Flat Part 1 paths, which this lesson exists to empty. */
const partOneBaselinePath = "factory/refactor-quality-before.txt";
const partOneFindingsPath = "factory/refactor-validate-findings.txt";

/**
 * What Part 1 left behind. Lesson 005's first step is a `mv`, so the flat files
 * have to be in the workspace for there to be anything to move — including the
 * stale findings file the specification tells the learner to delete.
 */
export const partOneSeed: Record<string, string> = {
  [partOneRefactorPath]: partOneRefactor,
  [partOneDoPath]: partOneDo,
  [partOneValidatePath]: partOneValidate,
  [partOneValidateShPath]: partOneValidateSh,
  [partOneBaselinePath]: "eslint: 3 findings\nknip: 1 finding\n",
  [partOneFindingsPath]: "VERDICT: PASS\n\nEVIDENCE:\n- last week's output\n"
};

/** The `mv` half of the move: every flat path is gone once the folder exists. */
const partOneRemoved: Record<string, null> = Object.fromEntries(Object.keys(partOneSeed).map((path) => [path, null]));
const partOneAbsent: ArtifactState = Object.fromEntries(Object.keys(partOneSeed).map((path) => [path, { exists: false }]));

const staleParentDo = relocatedDo.replaceAll("(cd ../../calculator", "(cd ../calculator");
const unsharedCriteriaRun = correctLineRun.replace("cat refactor.md success.md |", "cat refactor.md |");
const noPauseRun = correctLineRun.replace(/ {2}read -r -p .*\n/, "");

const lineScriptExpectations: FileExpectation = {
  exists: true,
  contains: [
    /while true; do/,
    /Recording quality baseline/,
    /\(cd \.\.\/\.\.\/calculator && node scripts\/quality\.mjs\) > quality-before\.txt/,
    /Starting doer/,
    /cat refactor\.md success\.md \| \(cd \.\.\/\.\.\/calculator && pi --no-session --tools read,edit,write,grep,find,ls -p\)/,
    /Starting validation/,
    /cat validate\.md success\.md quality-before\.txt/,
    /--tools read,grep,find,ls,bash -p/,
    /tee validate-findings\.txt/,
    /read -r -p/
  ],
  excludes: [/refactor-quality-before\.txt/, /\(cd \.\.\/calculator/, /repair\.md/]
};

const successExpectations: FileExpectation = {
  exists: true,
  contains: [
    /passes? its tests|passes? tests/i,
    /reveals? intention|intention[- ]revealing/i,
    /no duplication|duplication/i,
    /fewest elements|few elements|minimal elements/i,
    /many|multiple|series/i,
    /not a checklist|not .*checklist|destination|durable strategy/i,
    /evidence/i
  ]
};

/**
 * `factory/refactor/success.md` must stay a key of this map. The gate's
 * simple-design assertion reads the criteria out of the files it loaded from
 * `finalState`'s keys, so dropping the key would have it grade an empty string
 * and fail a correct artefact.
 */
export const lesson005FinalState: ArtifactState = {
  [successPath]: successExpectations,
  [refactorPath]: { exists: true, contains: [/one small/, /behaviour-preserving|behavior-preserving/i, /appended below/i], excludes: [/success\.md/] },
  [validatePath]: { exists: true, contains: [/VERDICT: PASS/, /VERDICT: FAIL/, /one finding for every criterion/i, /Do not modify any file/i, /passing tests alone/i], excludes: [/success\.md/] },
  [doPath]: { exists: true, contains: [/cat refactor\.md success\.md \|/, /\(cd \.\.\/\.\.\/calculator/, /quality-before\.txt/], excludes: [/\(cd \.\.\/calculator && /, /refactor-quality-before\.txt/] },
  [validateShPath]: { exists: true, contains: [/if \[ ! -f quality-before\.txt \]/, /\.\/do\.sh/, /cat validate\.md success\.md quality-before\.txt/, /tee validate-findings\.txt/], excludes: [/\(cd \.\.\/calculator && /, /refactor-validate/] },
  [linePath]: lineScriptExpectations,
  // The folder carries the line's name now, so nothing flat may survive beside
  // it — which is also what makes the delegated file scope for `factory/` real.
  ...partOneAbsent
};

const contains = (path: string, patterns: RegExp[], excludes: RegExp[] = []): ArtifactState => ({ [path]: { exists: true, contains: patterns, excludes } });

/** Where the moved files land, and what the flat paths must have become. */
const relocatedFiles: Record<string, string | null> = {
  [refactorPath]: relocatedRefactor, [validatePath]: relocatedValidate,
  [doPath]: relocatedDo, [validateShPath]: relocatedValidateSh,
  "factory/refactor/quality-before.txt": "eslint: 3 findings\nknip: 1 finding\n",
  ...partOneRemoved
};

const relocateStep = (): CanonicalPatch => ({
  name: "relocate",
  files: relocatedFiles,
  message: "I've moved the line into its own folder, dropped the prefixes, deleted last week's findings, and fixed the stale names inside the scripts. Please check it.",
  preconditions: { [partOneDoPath]: { exists: true }, [doPath]: { exists: false } },
  expectedState: {
    [doPath]: { exists: true, contains: [/\(cd \.\.\/\.\.\/calculator/, /quality-before\.txt/], excludes: [/\(cd \.\.\/calculator && /, /refactor-quality-before\.txt/] },
    [validateShPath]: { exists: true, contains: [/\.\/do\.sh/, /tee validate-findings\.txt/], excludes: [/refactor-validate/] },
    ...partOneAbsent
  },
  checkpoint: "guided-step"
});
const successStep = (): CanonicalPatch => ({
  name: "success", files: { [successPath]: success },
  message: "I've written the criteria the line is working towards. Please check them.",
  preconditions: { [doPath]: { exists: true }, [successPath]: { exists: false } },
  expectedState: { [successPath]: successExpectations }, checkpoint: "guided-step"
});
const criteriaStep = (): CanonicalPatch => ({
  name: "criteria",
  files: { [refactorPath]: refactor, [validatePath]: validate, [doPath]: correctDo, [validateShPath]: correctValidateSh },
  message: "I've pointed both prompts at the criteria and updated the callers that hand them over. Please check it.",
  preconditions: { [successPath]: successExpectations },
  expectedState: {
    [refactorPath]: lesson005FinalState[refactorPath]!,
    [validatePath]: lesson005FinalState[validatePath]!,
    [doPath]: lesson005FinalState[doPath]!,
    [validateShPath]: lesson005FinalState[validateShPath]!
  },
  checkpoint: "guided-step"
});
const runStep = (): CanonicalPatch => ({
  name: "run", files: { [linePath]: correctLineRun },
  message: "I've added the script that runs the line in order. Please check it.",
  preconditions: { [successPath]: successExpectations, [linePath]: { exists: false } },
  expectedState: { [linePath]: lineScriptExpectations }, checkpoint: "guided-step"
});

const runDefect = (name: "unshared-criteria" | "no-pause"): CanonicalPatch => ({
  name: "defect", files: { [linePath]: name === "unshared-criteria" ? unsharedCriteriaRun : noPauseRun },
  message: "I've added the script that runs the line in order. Please give feedback.",
  preconditions: { [successPath]: successExpectations, [linePath]: { exists: false } },
  expectedState: name === "unshared-criteria"
    ? contains(linePath, [/cat refactor\.md \| \(cd/], [/cat refactor\.md success\.md/])
    : contains(linePath, [/while true; do/], [/read -r -p/]),
  checkpoint: "guided-step"
});
const runRepair = (broken: CanonicalPatch): CanonicalPatch => ({
  name: "repair", files: { [linePath]: correctLineRun },
  message: "I've applied the smallest repair. Please check it.",
  preconditions: broken.expectedState,
  expectedState: { [linePath]: lineScriptExpectations }, checkpoint: "correction"
});

const staleParentDefect = (): CanonicalPatch => ({
  name: "defect", files: { ...relocateStep().files, [doPath]: staleParentDo },
  message: "I've moved the line into its own folder. Please give feedback.",
  preconditions: { [partOneDoPath]: { exists: true }, [doPath]: { exists: false } },
  expectedState: contains(doPath, [/\(cd \.\.\/calculator && /], [/\(cd \.\.\/\.\.\/calculator/]),
  checkpoint: "guided-step"
});
const staleParentRepair = (broken: CanonicalPatch): CanonicalPatch => ({
  name: "repair", files: { [doPath]: relocatedDo },
  message: "I've applied the smallest path repair. Please check it.",
  preconditions: broken.expectedState,
  expectedState: contains(doPath, [/\(cd \.\.\/\.\.\/calculator/], [/\(cd \.\.\/calculator && /]),
  checkpoint: "correction"
});

/**
 * The likeliest real mistake in a move lesson: the nested folder is written, but
 * the flat originals are left where they were. The specification spends four
 * paragraphs on this, and the delegated file scope for `factory/` is the gate
 * that catches it.
 */
const survivingFlatFilesDefect = (): CanonicalPatch => ({
  name: "defect",
  files: { ...Object.fromEntries(Object.entries(relocatedFiles).filter(([, contents]) => contents !== null)), ...partOneSeed },
  message: "I've copied the line into its own folder. Please give feedback.",
  preconditions: { [partOneDoPath]: { exists: true }, [doPath]: { exists: false } },
  expectedState: {
    [doPath]: { exists: true },
    [partOneDoPath]: { exists: true },
    [partOneFindingsPath]: { exists: true }
  },
  checkpoint: "guided-step"
});
const survivingFlatFilesRepair = (broken: CanonicalPatch): CanonicalPatch => ({
  name: "repair", files: partOneRemoved,
  message: "I've deleted the originals the copy left behind. Please check it.",
  preconditions: broken.expectedState,
  expectedState: partOneAbsent, checkpoint: "correction"
});

const unsharedDefect = runDefect("unshared-criteria");
const noPauseDefect = runDefect("no-pause");
const staleDefect = staleParentDefect();
const survivingDefect = survivingFlatFilesDefect();

export const lesson005Scenarios: Scenario[] = [
  { id: "line-agent-led-happy-path", lesson: "005", mode: "delegate", description: "Delegating learner gives the line its own folder, its criteria, and the script that runs it in order.", seed: partOneSeed, patches: [], finalState: lesson005FinalState },
  { id: "line-learner-led-happy-path", lesson: "005", mode: "hands-on", description: "Hands-on learner moves the line into its own folder, writes the criteria, points both prompts at them, and adds the run script, one canonical edit at a time.", seed: partOneSeed, patches: [relocateStep(), successStep(), criteriaStep(), runStep()], finalState: lesson005FinalState },
  { id: "mistake-flat-files-survive-the-move", lesson: "005", mode: "mistake", description: "Hands-on learner copies the line into its own folder instead of moving it, leaving the flat Part 1 files and last week's findings beside it.", expectedMistake: "Two copies of every prompt and script now exist, so an edit to one silently leaves the other behind, and the stale findings file sits where the line writes its own.", seed: partOneSeed, patches: [survivingDefect, survivingFlatFilesRepair(survivingDefect), successStep(), criteriaStep(), runStep()], finalState: lesson005FinalState },
  { id: "mistake-stale-parent-path-after-the-move", lesson: "005", mode: "mistake", description: "Hands-on learner moves the scripts a directory deeper but leaves them reaching for `../calculator`.", expectedMistake: "The relocated script points at a directory that does not exist, which is what running the move once would have caught.", seed: partOneSeed, patches: [staleDefect, staleParentRepair(staleDefect), successStep(), criteriaStep(), runStep()], finalState: lesson005FinalState },
  { id: "mistake-criteria-not-handed-to-the-doer", lesson: "005", mode: "mistake", description: "Hands-on learner writes the criteria but leaves the run script's doer turn sending only `refactor.md`.", expectedMistake: "The doer's prompt defers to criteria nobody hands it, so the machine is asked to work towards something it never receives.", seed: partOneSeed, patches: [relocateStep(), successStep(), criteriaStep(), unsharedDefect, runRepair(unsharedDefect)], finalState: lesson005FinalState },
  { id: "mistake-line-without-enter-pause", lesson: "005", mode: "mistake", description: "Hands-on learner writes the loop without the Enter pause between iterations.", expectedMistake: "The line never hands control back, so it keeps spending machine turns on the calculator with nobody reading the verdicts.", seed: partOneSeed, patches: [relocateStep(), successStep(), criteriaStep(), noPauseDefect, runRepair(noPauseDefect)], finalState: lesson005FinalState }
];
