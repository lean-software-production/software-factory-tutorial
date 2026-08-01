import type { ArtifactState, CanonicalPatch, Scenario } from "../lesson-001/scenarios.js";
import { refactor, refactorPath, runPath, success, successPath } from "../lesson-001/scenarios.js";
import { review, reviewPath } from "../lesson-002/scenarios.js";

export const repairPath = "factory/repair.md";

export const repair = `Read \`../factory/success.md\` and \`../factory/review-report.md\`, then make the smallest correction that addresses the failed criteria.

Edit files directly. Do not run tests, npm, or shell commands. Keep your response concise.
`;

export const correctRoutingRun = `#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
while true; do
  if [ ! -f review-report.md ] || grep -qx 'VERDICT: PASS' review-report.md; then
    echo "Starting doer iteration..."
    cat refactor.md | (cd ../calculator && pi --no-session --tools read,edit,write,grep,find,ls -p)
  elif grep -qx 'VERDICT: FAIL' review-report.md; then
    echo "Starting repair iteration..."
    cat repair.md | (cd ../calculator && pi --no-session --tools read,edit,write,grep,find,ls -p)
  else
    echo "Review report has no valid verdict; stopping for human review." >&2
    exit 1
  fi

  echo "Starting review..."
  cat review.md success.md | (cd ../calculator && pi --no-session --tools read,grep,find,ls,bash -p) | tee review-report.md

  read -r -p "Press Enter for the next iteration (Ctrl-C to stop)... "
done
`;

const invertedRoutingRun = correctRoutingRun
  .replace("if [ ! -f review-report.md ] || grep -qx 'VERDICT: PASS' review-report.md; then", "if grep -qx 'VERDICT: FAIL' review-report.md; then")
  .replace("elif grep -qx 'VERDICT: FAIL' review-report.md; then", "elif [ ! -f review-report.md ] || grep -qx 'VERDICT: PASS' review-report.md; then");

export const lesson004FinalState: ArtifactState = {
  [successPath]: { exists: true },
  [refactorPath]: { exists: true },
  [reviewPath]: { exists: true },
  [repairPath]: { exists: true, contains: [/review-report\.md/, /success\.md/, /Do not run tests, npm, or shell commands/] },
  [runPath]: { exists: true, contains: [/tee review-report\.md/, /grep -qx 'VERDICT: PASS'/, /grep -qx 'VERDICT: FAIL'/, /Starting repair iteration/, /cat repair\.md \|/, /Review report has no valid verdict/], excludes: [/test-failure\.log/, /fix-tests\.md/] }
};

const baseFiles = { [successPath]: success, [refactorPath]: refactor, [reviewPath]: review, [repairPath]: repair };
const routingDefect: CanonicalPatch = {
  name: "defect", files: { ...baseFiles, [runPath]: invertedRoutingRun }, message: "I've added verdict routing. Please give feedback.",
  preconditions: { [runPath]: { exists: false } }, expectedState: { [runPath]: { exists: true, contains: [/if grep -qx 'VERDICT: FAIL'/] } }, checkpoint: "guided-step"
};
const routingRepair: CanonicalPatch = {
  name: "repair", files: { ...baseFiles, [runPath]: correctRoutingRun }, message: "I've corrected the verdict routing. Please check it.",
  preconditions: routingDefect.expectedState, expectedState: lesson004FinalState, checkpoint: "correction"
};

export const lesson004Scenarios: Scenario[] = [{
  id: "mistake-inverted-verdict-routing",
  lesson: "004",
  mode: "mistake",
  description: "Hands-on learner sends failed review reports to normal refactoring instead of repair.",
  expectedMistake: "A previous VERDICT: FAIL must select repair.md, while no report or PASS selects refactor.md.",
  patches: [routingDefect, routingRepair],
  finalState: lesson004FinalState
}];
