import type { ArtifactState, CanonicalPatch, Scenario } from "../lesson-001/scenarios.js";
import { correctRun as lesson001Run, lesson001FinalState, refactor, refactorPath, runPath, success, successPath } from "../lesson-001/scenarios.js";

export const reviewPath = "factory/review.md";

export const review = `Inspect the doer's previous change against \`success.md\`.

Read the code and diff, run tests and relevant installed complexity or quality tools, and report independent evidence. Verify preserved behaviour and assess whether the change advances, or at least does not compromise, every criterion. Do not expect one small refactoring to achieve the whole destination. Do not modify files.

Your response format is:

VERDICT: PASS

FINDINGS:
- [PASS] <success criterion>: <specific evidence>
- [FAIL] <success criterion>: <specific evidence>

The first non-empty line must be exactly \`VERDICT: PASS\` or \`VERDICT: FAIL\`. Give one finding for every criterion in \`success.md\`. Passing tests alone are not a passing review.
`;

export const correctReviewRun = `#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
echo "Starting doer..."
cat refactor.md | (cd ../calculator && pi --no-session --tools read,edit,write,grep,find,ls -p)

echo "Starting review..."
cat review.md success.md | (cd ../calculator && pi --no-session --tools read,grep,find,ls,bash -p)
`;

const reviewerCanEditRun = correctReviewRun.replace("read,grep,find,ls,bash", "read,edit,write,grep,find,ls,bash");

const contains = (path: string, patterns: RegExp[], excludes: RegExp[] = []): ArtifactState => ({ [path]: { exists: true, contains: patterns, excludes } });

export const lesson002FinalState: ArtifactState = {
  ...lesson001FinalState,
  [reviewPath]: { exists: true, contains: [/VERDICT: PASS/, /VERDICT: FAIL/, /one finding for every criterion/i, /Do not modify files/i, /Passing tests alone/i] },
  [runPath]: { exists: true, contains: [/Starting doer/, /Starting review/, /cat refactor\.md \|/, /cat review\.md success\.md \|/, /--tools read,grep,find,ls,bash -p/], excludes: [/while true/, /read -r -p/, /--tools read,edit,write,grep,find,ls,bash/] }
};

const baseFiles = { [successPath]: success, [refactorPath]: refactor, [reviewPath]: review };

const reviewerToolDefect: CanonicalPatch = {
  name: "defect", files: { ...baseFiles, [runPath]: reviewerCanEditRun }, message: "I've added the reviewer invocation. Please give feedback.",
  preconditions: { [runPath]: { exists: false } }, expectedState: contains(runPath, [/Starting review/, /--tools read,edit,write,grep,find,ls,bash/]), checkpoint: "guided-step"
};
const reviewerToolRepair: CanonicalPatch = {
  name: "repair", files: { ...baseFiles, [runPath]: correctReviewRun }, message: "I've removed edit access from the reviewer. Please check it.",
  preconditions: reviewerToolDefect.expectedState, expectedState: lesson002FinalState, checkpoint: "correction"
};

export const lesson002Scenarios: Scenario[] = [{
  id: "mistake-reviewer-can-edit",
  lesson: "002",
  mode: "mistake",
  description: "Hands-on learner gives the reviewer edit/write tools.",
  expectedMistake: "The reviewer must gather independent evidence without modifying files.",
  patches: [reviewerToolDefect, reviewerToolRepair],
  finalState: lesson002FinalState
}];

// Kept for tests that need a complete preceding lesson artifact.
export const lesson001CompleteFiles = { [successPath]: success, [refactorPath]: refactor, [runPath]: lesson001Run };
