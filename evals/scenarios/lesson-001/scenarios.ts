export type LearnerMode = "delegate" | "hands-on" | "mistake";

export interface CanonicalPatch {
  name: string;
  files: Record<string, string>;
  message: string;
  expectedState: RegExp[];
}

export interface Scenario {
  id: string;
  lesson: "001" | "002";
  mode: LearnerMode;
  description: string;
  expectedMistake?: string;
  patches: CanonicalPatch[];
}

export const correctFactory = `#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

while true; do
  echo "Starting refactoring iteration..."
  cat refactor.md | (cd ../calculator && pi --no-session --tools read,edit,write,grep,find,ls -p)
  read -r -p "Press Enter for the next iteration (Ctrl-C to stop)... "
done
`;

const refactor = `Inspect the calculator and make one small, behaviour-preserving refactoring. Edit files directly. Do not run tests, npm, or shell commands. Keep your response concise.\n`;
const patch = (name: string, factory: string, message: string): CanonicalPatch => ({
  name,
  files: { "factory/factory.sh": factory, "factory/refactor.md": refactor },
  message,
  expectedState: [/while true; do/, /read -r -p/, /pi --no-session --tools read,edit,write,grep,find,ls -p/]
});

const missingTools = correctFactory.replace(" --tools read,edit,write,grep,find,ls", "");
const wrongDirectory = correctFactory.replace("(cd ../calculator && pi", "(cd .. && pi");
const invalidPrompt = "Inspect the calculator, run npm test and shell commands, then refactor it.\n";
const noPause = correctFactory.replace('  read -r -p "Press Enter for the next iteration (Ctrl-C to stop)... "\n', "");

export const scenarios: Scenario[] = [
  { id: "agent-led-happy-path", lesson: "001", mode: "delegate", description: "Delegating learner completes only the required factory files.", patches: [] },
  { id: "learner-led-happy-path", lesson: "001", mode: "hands-on", description: "Hands-on learner asks for exact typing guidance and applies the canonical factory.", patches: [patch("complete", correctFactory, "I've made the Bash loop, pause, Pi command, and prompt. Please check it.")] },
  { id: "mistake-missing-tools", lesson: "001", mode: "mistake", description: "Hands-on learner omits Pi's tool allowlist.", expectedMistake: "The worker has lost its tool allowlist isolation boundary.", patches: [patch("defect", missingTools, "I've made the step. Please give feedback."), patch("repair", correctFactory, "I've applied the smallest repair. Please check it.")] },
  { id: "mistake-wrong-calculator-directory", lesson: "001", mode: "mistake", description: "Hands-on learner starts Pi outside calculator.", expectedMistake: "The worker is not scoped to the calculator directory.", patches: [patch("defect", wrongDirectory, "I've made the step. Please give feedback."), patch("repair", correctFactory, "I've applied the smallest repair. Please check it.")] },
  { id: "mistake-invalid-prompt-boundary", lesson: "001", mode: "mistake", description: "Hands-on learner gives the worker validation authority.", expectedMistake: "Validation is no longer independent from the worker.", patches: [{ ...patch("defect", correctFactory, "I've made the step. Please give feedback."), files: { "factory/factory.sh": correctFactory, "factory/refactor.md": invalidPrompt }, expectedState: [/npm test/] }, patch("repair", correctFactory, "I've applied the smallest repair. Please check it.")] },
  { id: "mistake-no-enter-pause", lesson: "001", mode: "mistake", description: "Hands-on learner omits the control pause.", expectedMistake: "The learner has no Enter control point between turns.", patches: [patch("defect", noPause, "I've made the step. Please give feedback."), patch("repair", correctFactory, "I've applied the smallest repair. Please check it.")] }
];

export function findScenario(id: string): Scenario | undefined { return scenarios.find((scenario) => scenario.id === id); }
