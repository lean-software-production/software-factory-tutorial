export type LearnerMode = "delegate" | "hands-on" | "mistake";

export interface FileExpectation {
  exists?: boolean;
  contains?: RegExp[];
  excludes?: RegExp[];
}

/** Expectations are file-specific so a defect cannot accidentally match a healthy sibling file. */
export type ArtifactState = Record<string, FileExpectation>;

export interface CanonicalPatch {
  name: string;
  /** The only files the deterministic learner changes in this atomic step. */
  files: Record<string, string>;
  message: string;
  /** State that must exist immediately before the learner makes this edit. */
  preconditions: ArtifactState;
  /** State captured immediately after this edit, before any later repair. */
  expectedState: ArtifactState;
  checkpoint: "guided-step" | "correction";
}

export interface Scenario {
  id: string;
  lesson: "001" | "002";
  mode: LearnerMode;
  description: string;
  expectedMistake?: string;
  /** Ordered, small learner edits. `defect` and `repair` retain stable report names. */
  patches: CanonicalPatch[];
}

const factoryPath = "factory/factory.sh";
const promptPath = "factory/refactor.md";
const shellHeader = `#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

`;
const placeholder = "  # Add the factory turn here.\n";
const loop = `${shellHeader}while true; do
${placeholder}done
`;
const withPause = loop.replace(placeholder, '  read -r -p "Press Enter for the next iteration (Ctrl-C to stop)... "\n');
const piCommand = '  echo "Starting refactoring iteration..."\n  cat refactor.md | (cd ../calculator && pi --no-session --tools read,edit,write,grep,find,ls -p)\n';
const withoutTools = piCommand.replace(" --tools read,edit,write,grep,find,ls", "");
const wrongDirectoryCommand = piCommand.replace("(cd ../calculator && pi", "(cd .. && pi");
export const correctFactory = withPause.replace('  read -r -p "Press Enter for the next iteration (Ctrl-C to stop)... "\n', `${piCommand}  read -r -p "Press Enter for the next iteration (Ctrl-C to stop)... "\n`);
const refactor = "Inspect the calculator and make one small, behaviour-preserving refactoring. Edit files directly. Do not run tests, npm, or shell commands. Keep your response concise.\n";
const invalidPrompt = "Inspect the calculator, run npm test and shell commands, then refactor it.\n";

const absent = (path: string): ArtifactState => ({ [path]: { exists: false } });
const contains = (path: string, patterns: RegExp[], excludes: RegExp[] = []): ArtifactState => ({ [path]: { exists: true, contains: patterns, excludes } });

const loopStep = (): CanonicalPatch => ({
  name: "loop", files: { [factoryPath]: loop }, message: "I've completed the Bash loop step. Please check it.",
  preconditions: absent(factoryPath), expectedState: contains(factoryPath, [/while true; do/, /# Add the factory turn here\./]), checkpoint: "guided-step"
});
const pauseStep = (): CanonicalPatch => ({
  name: "pause", files: { [factoryPath]: withPause }, message: "I've added the learner pause. Please check it.",
  preconditions: contains(factoryPath, [/# Add the factory turn here\./]), expectedState: contains(factoryPath, [/read -r -p/, /while true; do/]), checkpoint: "guided-step"
});
const invokeStep = (): CanonicalPatch => ({
  name: "invoke", files: { [factoryPath]: correctFactory }, message: "I've added the announcement and isolated Pi invocation. Please check it.",
  preconditions: contains(factoryPath, [/read -r -p/], [/pi --no-session/]), expectedState: contains(factoryPath, [/Starting refactoring iteration/, /\(cd \.\.\/calculator && pi --no-session --tools read,edit,write,grep,find,ls -p\)/]), checkpoint: "guided-step"
});
const promptStep = (): CanonicalPatch => ({
  name: "prompt", files: { [promptPath]: refactor }, message: "I've written the worker prompt. Please check it.",
  preconditions: absent(promptPath), expectedState: contains(promptPath, [/behaviour-preserving refactoring/, /Do not run tests, npm, or shell commands/]), checkpoint: "guided-step"
});
const defectInvoke = (name: "missing-tools" | "wrong-directory"): CanonicalPatch => {
  const factory = name === "missing-tools"
    ? withPause.replace('  read -r -p "Press Enter for the next iteration (Ctrl-C to stop)... "\n', `${withoutTools}  read -r -p "Press Enter for the next iteration (Ctrl-C to stop)... "\n`)
    : withPause.replace('  read -r -p "Press Enter for the next iteration (Ctrl-C to stop)... "\n', `${wrongDirectoryCommand}  read -r -p "Press Enter for the next iteration (Ctrl-C to stop)... "\n`);
  const expected = name === "missing-tools"
    ? contains(factoryPath, [/pi --no-session -p/, /read -r -p/], [/--tools/])
    : contains(factoryPath, [/\(cd \.\. && pi --no-session --tools/, /read -r -p/], [/\(cd \.\.\/calculator && pi/]);
  return {
    name: "defect", files: { [factoryPath]: factory }, message: "I've made the invocation step. Please give feedback.",
    preconditions: contains(factoryPath, [/read -r -p/], [/pi --no-session/]), expectedState: expected, checkpoint: "guided-step"
  };
};
const repairInvoke = (defect: CanonicalPatch): CanonicalPatch => ({
  name: "repair", files: { [factoryPath]: correctFactory }, message: "I've applied the smallest repair. Please check it.",
  preconditions: defect.expectedState,
  expectedState: contains(factoryPath, [/\(cd \.\.\/calculator && pi --no-session --tools read,edit,write,grep,find,ls -p\)/, /read -r -p/]), checkpoint: "correction"
});
const invalidPromptDefect = (): CanonicalPatch => ({
  name: "defect", files: { [promptPath]: invalidPrompt }, message: "I've written the worker prompt. Please give feedback.",
  preconditions: absent(promptPath), expectedState: contains(promptPath, [/npm test/, /shell commands/]), checkpoint: "guided-step"
});
const promptRepair = (defect: CanonicalPatch): CanonicalPatch => ({
  name: "repair", files: { [promptPath]: refactor }, message: "I've applied the smallest repair. Please check it.",
  preconditions: defect.expectedState,
  expectedState: contains(promptPath, [/behaviour-preserving refactoring/, /Do not run tests, npm, or shell commands/]), checkpoint: "correction"
});
const noPauseDefect = (): CanonicalPatch => ({
  name: "defect", files: { [factoryPath]: loop }, message: "I've made the control-flow step. Please give feedback.",
  preconditions: contains(factoryPath, [/# Add the factory turn here\./]), expectedState: contains(factoryPath, [/while true; do/], [/read -r -p/]), checkpoint: "guided-step"
});
const noPauseRepair = (defect: CanonicalPatch): CanonicalPatch => ({
  name: "repair", files: { [factoryPath]: withPause }, message: "I've applied the smallest repair. Please check it.",
  preconditions: defect.expectedState,
  expectedState: contains(factoryPath, [/read -r -p/, /while true; do/]), checkpoint: "correction"
});

const missingToolsDefect = defectInvoke("missing-tools");
const wrongDirectoryDefect = defectInvoke("wrong-directory");
const invalidDefect = invalidPromptDefect();
const pauseDefect = noPauseDefect();

export const scenarios: Scenario[] = [
  { id: "agent-led-happy-path", lesson: "001", mode: "delegate", description: "Delegating learner completes every offered delegation step.", patches: [] },
  { id: "learner-led-happy-path", lesson: "001", mode: "hands-on", description: "Hands-on learner requests exact guidance and completes one canonical edit per required step.", patches: [loopStep(), pauseStep(), invokeStep(), promptStep()] },
  { id: "mistake-missing-tools", lesson: "001", mode: "mistake", description: "Hands-on learner omits Pi's tool allowlist.", expectedMistake: "The worker has lost its tool allowlist isolation boundary.", patches: [loopStep(), pauseStep(), missingToolsDefect, repairInvoke(missingToolsDefect), promptStep()] },
  { id: "mistake-wrong-calculator-directory", lesson: "001", mode: "mistake", description: "Hands-on learner starts Pi outside calculator.", expectedMistake: "The worker is not scoped to the calculator directory.", patches: [loopStep(), pauseStep(), wrongDirectoryDefect, repairInvoke(wrongDirectoryDefect), promptStep()] },
  { id: "mistake-invalid-prompt-boundary", lesson: "001", mode: "mistake", description: "Hands-on learner gives the worker validation authority.", expectedMistake: "Validation is no longer independent from the worker.", patches: [loopStep(), pauseStep(), invokeStep(), invalidDefect, promptRepair(invalidDefect)] },
  { id: "mistake-no-enter-pause", lesson: "001", mode: "mistake", description: "Hands-on learner omits the control pause.", expectedMistake: "The learner has no Enter control point between turns.", patches: [loopStep(), pauseDefect, noPauseRepair(pauseDefect), invokeStep(), promptStep()] }
];

export function findScenario(id: string): Scenario | undefined { return scenarios.find((scenario) => scenario.id === id); }
