import type { Scenario } from "../lesson-001/scenarios.js";

const correct = `#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
while true; do
  if [ -f test-failure.log ]; then
    cat fix-tests.md test-failure.log | (cd ../calculator && pi --no-session --tools read,edit,write,grep,find,ls -p)
  else
    cat refactor.md | (cd ../calculator && pi --no-session --tools read,edit,write,grep,find,ls -p)
  fi
  if (cd ../calculator && npm test) 2>test-failure.log; then rm -f test-failure.log; else cat test-failure.log; fi
  read -r -p "Press Enter for the next iteration (Ctrl-C to stop)... "
done
`;
const inverted = correct.replace("if [ -f test-failure.log ]; then", "if [ ! -f test-failure.log ]; then");

export const lesson002Scenarios: Scenario[] = [{
  id: "mistake-inverted-recovery-branch",
  lesson: "002",
  mode: "mistake",
  description: "Hands-on learner reverses the recovery evidence branch.",
  expectedMistake: "A failure must choose healing and no failure must choose normal refactoring.",
  patches: [
    {
      name: "defect", files: { "factory/factory.sh": inverted, "factory/refactor.md": "Refactor safely.\n", "factory/fix-tests.md": "Heal the failing test.\n" }, message: "I've made the recovery step. Please give feedback.",
      preconditions: { "factory/factory.sh": { exists: false } }, expectedState: { "factory/factory.sh": { contains: [/if \[ ! -f test-failure\.log \]/] } }, checkpoint: "guided-step"
    },
    {
      name: "repair", files: { "factory/factory.sh": correct, "factory/refactor.md": "Refactor safely.\n", "factory/fix-tests.md": "Heal the failing test.\n" }, message: "I've corrected the branch. Please check it.",
      preconditions: { "factory/factory.sh": { contains: [/if \[ ! -f test-failure\.log \]/] } }, expectedState: { "factory/factory.sh": { contains: [/if \[ -f test-failure\.log \]/] } }, checkpoint: "correction"
    }
  ]
}];
