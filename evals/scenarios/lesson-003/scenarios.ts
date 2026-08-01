import type { ArtifactState, CanonicalPatch, Scenario } from "../lesson-001/scenarios.js";
import { refactor, refactorPath, runPath, success, successPath } from "../lesson-001/scenarios.js";
import { review, reviewPath } from "../lesson-002/scenarios.js";

export const correctLoopRun = `#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
while true; do
  echo "Starting doer iteration..."
  cat refactor.md | (cd ../calculator && pi --no-session --tools read,edit,write,grep,find,ls -p)

  echo "Starting review..."
  cat review.md success.md | (cd ../calculator && pi --no-session --tools read,grep,find,ls,bash -p)

  read -r -p "Press Enter for the next iteration (Ctrl-C to stop)... "
done
`;

const noPauseRun = correctLoopRun.replace('\n\n  read -r -p "Press Enter for the next iteration (Ctrl-C to stop)... "', "");

export const lesson003FinalState: ArtifactState = {
  [successPath]: { exists: true },
  [refactorPath]: { exists: true },
  [reviewPath]: { exists: true },
  [runPath]: { exists: true, contains: [/while true; do/, /Starting doer iteration/, /Starting review/, /read -r -p/], excludes: [/tee review-report\.md/, /repair\.md/] }
};

const baseFiles = { [successPath]: success, [refactorPath]: refactor, [reviewPath]: review };
const noPauseDefect: CanonicalPatch = {
  name: "defect", files: { ...baseFiles, [runPath]: noPauseRun }, message: "I've added the repeated loop. Please give feedback.",
  preconditions: { [runPath]: { exists: false } }, expectedState: { [runPath]: { exists: true, contains: [/while true; do/], excludes: [/read -r -p/] } }, checkpoint: "guided-step"
};
const noPauseRepair: CanonicalPatch = {
  name: "repair", files: { ...baseFiles, [runPath]: correctLoopRun }, message: "I've restored the learner pause. Please check it.",
  preconditions: noPauseDefect.expectedState, expectedState: lesson003FinalState, checkpoint: "correction"
};

export const lesson003Scenarios: Scenario[] = [{
  id: "mistake-loop-without-enter-pause",
  lesson: "003",
  mode: "mistake",
  description: "Hands-on learner repeats the doer/reviewer loop without the human Enter pause.",
  expectedMistake: "The repeated loop must pause after each review so the learner remains in control.",
  patches: [noPauseDefect, noPauseRepair],
  finalState: lesson003FinalState
}];
