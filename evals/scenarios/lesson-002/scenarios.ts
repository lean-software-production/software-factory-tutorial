import type { ArtifactState, CanonicalPatch, FileExpectation, Scenario } from "../lesson-001/scenarios.js";

export const refactorPath = "factory/refactor.md";
export const runPath = "factory/refactor-do.sh";

export const refactor = `Choose one small, behaviour-preserving refactoring that makes the calculator clearer, and make it.

Edit files directly. Do not run tests, npm, or shell commands. Keep your response concise.
`;

export const correctRun = `#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
echo "Recording quality baseline..."
(cd ../calculator && node scripts/quality.mjs) > refactor-quality-before.txt || true
echo "Starting doer..."
cat refactor.md | (cd ../calculator && pi --no-session --tools read,edit,write,grep,find,ls -p)
`;

const missingToolsRun = correctRun.replace(" --tools read,edit,write,grep,find,ls", "");
const wrongDirectoryRun = correctRun.replace("(cd ../calculator && pi", "(cd .. && pi");
const missingBaselineRun = correctRun.replace(`echo "Recording quality baseline..."
(cd ../calculator && node scripts/quality.mjs) > refactor-quality-before.txt || true
`, "");
const invalidPrompt = `Inspect the calculator, run npm test and any shell commands you need, then perform a refactoring.
`;

const contains = (path: string, patterns: RegExp[], excludes: RegExp[] = []): ArtifactState => ({ [path]: { exists: true, contains: patterns, excludes } });

const refactorExpectations: FileExpectation = {
  exists: true,
  contains: [/one small/, /behaviour-preserving|behavior-preserving/i, /Do not run tests, npm, or shell commands/],
  // The doer states its own job in this lesson; shared criteria arrive in lesson 005.
  excludes: [/success\.md/]
};

export const lesson002FinalState: ArtifactState = {
  [refactorPath]: refactorExpectations,
  [runPath]: {
    exists: true,
    contains: [
      /Recording quality baseline/,
      /refactor-quality-before\.txt/,
      /Starting doer/,
      /cat refactor\.md \|/,
      /\(cd \.\.\/calculator && pi --no-session --tools read,edit,write,grep,find,ls -p\)/
    ],
    excludes: [/while true/, /read -r -p/, /success\.md/]
  }
};

const promptStep = (): CanonicalPatch => ({
  name: "prompt", files: { [refactorPath]: refactor }, message: "I've written the doer prompt. Please check it.",
  preconditions: { [refactorPath]: { exists: false } },
  expectedState: { [refactorPath]: refactorExpectations }, checkpoint: "guided-step"
});
const invokeStep = (): CanonicalPatch => ({
  name: "invoke", files: { [runPath]: correctRun }, message: "I've added the one-shot doer invocation. Please check it.",
  preconditions: { [refactorPath]: { exists: true }, [runPath]: { exists: false } },
  expectedState: lesson002FinalState, checkpoint: "guided-step"
});
const defectInvoke = (name: "missing-tools" | "wrong-directory" | "missing-baseline"): CanonicalPatch => {
  const run = name === "missing-tools" ? missingToolsRun : name === "wrong-directory" ? wrongDirectoryRun : missingBaselineRun;
  const expected = name === "missing-tools"
    ? contains(runPath, [/pi --no-session -p/], [/--tools/])
    : name === "wrong-directory"
      ? contains(runPath, [/\(cd \.\. && pi --no-session --tools/], [/\(cd \.\.\/calculator && pi/])
      : contains(runPath, [/Starting doer/], [/Recording quality baseline/, /refactor-quality-before\.txt/]);
  return {
    name: "defect", files: { [runPath]: run }, message: "I've made the invocation step. Please give feedback.",
    preconditions: { [refactorPath]: { exists: true }, [runPath]: { exists: false } },
    expectedState: expected, checkpoint: "guided-step"
  };
};
const repairInvoke = (defect: CanonicalPatch): CanonicalPatch => ({
  name: "repair", files: { [runPath]: correctRun }, message: "I've applied the smallest invocation repair. Please check it.",
  preconditions: defect.expectedState, expectedState: { [runPath]: lesson002FinalState[runPath]! }, checkpoint: "correction"
});
const invalidPromptDefect = (): CanonicalPatch => ({
  name: "defect", files: { [refactorPath]: invalidPrompt }, message: "I've written the doer prompt. Please give feedback.",
  preconditions: { [refactorPath]: { exists: false } },
  expectedState: contains(refactorPath, [/npm test/, /shell commands/]), checkpoint: "guided-step"
});
const promptRepair = (defect: CanonicalPatch): CanonicalPatch => ({
  name: "repair", files: { [refactorPath]: refactor }, message: "I've applied the smallest prompt repair. Please check it.",
  preconditions: defect.expectedState, expectedState: { [refactorPath]: refactorExpectations }, checkpoint: "correction"
});

const missingToolsDefect = defectInvoke("missing-tools");
const wrongDirectoryDefect = defectInvoke("wrong-directory");
const missingBaselineDefect = defectInvoke("missing-baseline");
const invalidDefect = invalidPromptDefect();

export const lesson002Scenarios: Scenario[] = [
  { id: "doer-agent-led-happy-path", lesson: "002", mode: "delegate", description: "Delegating learner completes the doer prompt and its one-shot invocation.", patches: [], finalState: lesson002FinalState },
  { id: "doer-learner-led-happy-path", lesson: "002", mode: "hands-on", description: "Hands-on learner requests exact guidance and completes one canonical edit per required step.", patches: [promptStep(), invokeStep()], finalState: lesson002FinalState },
  { id: "mistake-missing-tools", lesson: "002", mode: "mistake", description: "Hands-on learner omits Pi's doer tool allowlist.", expectedMistake: "The doer has lost its file-tool boundary, so it can run the very checks the learner is meant to run themselves.", patches: [promptStep(), missingToolsDefect, repairInvoke(missingToolsDefect)], finalState: lesson002FinalState },
  { id: "mistake-wrong-calculator-directory", lesson: "002", mode: "mistake", description: "Hands-on learner starts Pi outside the calculator.", expectedMistake: "The doer is not scoped to the calculator directory.", patches: [promptStep(), wrongDirectoryDefect, repairInvoke(wrongDirectoryDefect)], finalState: lesson002FinalState },
  { id: "mistake-invalid-prompt-boundary", lesson: "002", mode: "mistake", description: "Hands-on learner tells the doer to run the checks on its own change.", expectedMistake: "A doer that runs the evidence is reporting on itself, and the independent check the next lesson builds becomes impossible.", patches: [invalidDefect, promptRepair(invalidDefect), invokeStep()], finalState: lesson002FinalState },
  { id: "mistake-missing-quality-baseline", lesson: "002", mode: "mistake", description: "Hands-on learner invokes the doer without first recording the quality baseline.", expectedMistake: "Nothing records what the calculator looked like before the change, so the next lesson's validator has nothing to compare against and can only assert an improvement.", patches: [promptStep(), missingBaselineDefect, repairInvoke(missingBaselineDefect)], finalState: lesson002FinalState }
];
