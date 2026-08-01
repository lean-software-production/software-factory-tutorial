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
  lesson: "001" | "002" | "003" | "004";
  mode: LearnerMode;
  description: string;
  expectedMistake?: string;
  /** Ordered, small learner edits. `defect` and `repair` retain stable report names. */
  patches: CanonicalPatch[];
  /** Final file-specific artifact expectations for deterministic offline gates. */
  finalState?: ArtifactState;
}

export const runPath = "factory/run.sh";
export const successPath = "factory/success.md";
export const refactorPath = "factory/refactor.md";

export const success = `# Success criteria

These criteria describe the destination for many small refactorings, not a checklist for one refactoring turn. The doer may choose any small tactic that moves the calculator in this direction while preserving behaviour.

1. Passes its tests. Evidence: the reviewer runs \`npm test\` from \`calculator/\` and reports the result.
2. Reveals intention. Evidence: the diff and code read with clearer names, responsibilities, and control flow.
3. No duplication. Evidence: repeated expressions or branches are removed without hiding meaning.
4. Fewest elements. Evidence: imports, helpers, branches, and abstractions are no more numerous than the behaviour requires; installed complexity tools may support this judgement.
`;

export const refactor = `Study \`../factory/success.md\` and use those criteria to choose one small, behaviour-preserving refactoring that moves the calculator toward the desired state.

Edit files directly. Do not run tests, npm, or shell commands. Keep your response concise.
`;

export const correctRun = `#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
echo "Starting doer..."
cat refactor.md | (cd ../calculator && pi --no-session --tools read,edit,write,grep,find,ls -p)
`;

const missingToolsRun = correctRun.replace(" --tools read,edit,write,grep,find,ls", "");
const wrongDirectoryRun = correctRun.replace("(cd ../calculator && pi", "(cd .. && pi");
const invalidPrompt = `Inspect the calculator, run npm test and any shell commands you need, then perform a refactoring.
`;
const checklistSuccess = `# Success for this refactoring

Checklist for the next refactoring: make the calculator cleaner, then run tests.
`;

const absent = (path: string): ArtifactState => ({ [path]: { exists: false } });
const contains = (path: string, patterns: RegExp[], excludes: RegExp[] = []): ArtifactState => ({ [path]: { exists: true, contains: patterns, excludes } });

export const successExpectations: FileExpectation = {
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

export const lesson001FinalState: ArtifactState = {
  [successPath]: successExpectations,
  [refactorPath]: { exists: true, contains: [/\.\.\/factory\/success\.md/, /one small/, /behaviour-preserving|behavior-preserving/i, /Do not run tests, npm, or shell commands/] },
  [runPath]: { exists: true, contains: [/Starting doer/, /cat refactor\.md \|/, /\(cd \.\.\/calculator && pi --no-session --tools read,edit,write,grep,find,ls -p\)/], excludes: [/while true/, /review\.md/, /read -r -p/] }
};

const successStep = (): CanonicalPatch => ({
  name: "success", files: { [successPath]: success }, message: "I've defined the durable success criteria. Please check them.",
  preconditions: absent(successPath), expectedState: { [successPath]: successExpectations }, checkpoint: "guided-step"
});
const promptStep = (): CanonicalPatch => ({
  name: "prompt", files: { [refactorPath]: refactor }, message: "I've written the doer prompt. Please check it.",
  preconditions: { [successPath]: successExpectations, [refactorPath]: { exists: false } },
  expectedState: { [refactorPath]: lesson001FinalState[refactorPath]! }, checkpoint: "guided-step"
});
const invokeStep = (): CanonicalPatch => ({
  name: "invoke", files: { [runPath]: correctRun }, message: "I've added the one-shot doer invocation. Please check it.",
  preconditions: { [successPath]: successExpectations, [refactorPath]: { exists: true, contains: [/\.\.\/factory\/success\.md/] }, [runPath]: { exists: false } }, expectedState: lesson001FinalState, checkpoint: "guided-step"
});
const defectInvoke = (name: "missing-tools" | "wrong-directory"): CanonicalPatch => {
  const run = name === "missing-tools" ? missingToolsRun : wrongDirectoryRun;
  const expected = name === "missing-tools"
    ? contains(runPath, [/pi --no-session -p/], [/--tools/])
    : contains(runPath, [/\(cd \.\. && pi --no-session --tools/], [/\(cd \.\.\/calculator && pi/]);
  return {
    name: "defect", files: { [runPath]: run }, message: "I've made the invocation step. Please give feedback.",
    preconditions: { [successPath]: successExpectations, [refactorPath]: { exists: true, contains: [/\.\.\/factory\/success\.md/] }, [runPath]: { exists: false } }, expectedState: expected, checkpoint: "guided-step"
  };
};
const repairInvoke = (defect: CanonicalPatch): CanonicalPatch => ({
  name: "repair", files: { [runPath]: correctRun }, message: "I've applied the smallest invocation repair. Please check it.",
  preconditions: defect.expectedState, expectedState: { [runPath]: lesson001FinalState[runPath]! }, checkpoint: "correction"
});
const invalidPromptDefect = (): CanonicalPatch => ({
  name: "defect", files: { [refactorPath]: invalidPrompt }, message: "I've written the doer prompt. Please give feedback.",
  preconditions: { [successPath]: successExpectations, [refactorPath]: { exists: false } }, expectedState: contains(refactorPath, [/npm test/, /shell commands/]), checkpoint: "guided-step"
});
const promptRepair = (defect: CanonicalPatch): CanonicalPatch => ({
  name: "repair", files: { [refactorPath]: refactor }, message: "I've applied the smallest prompt repair. Please check it.",
  preconditions: defect.expectedState, expectedState: { [refactorPath]: lesson001FinalState[refactorPath]! }, checkpoint: "correction"
});
const checklistSuccessDefect = (): CanonicalPatch => ({
  name: "defect", files: { [successPath]: checklistSuccess }, message: "I've drafted success.md. Please give feedback.",
  preconditions: absent(successPath), expectedState: contains(successPath, [/Checklist for the next refactoring/], [/reveals? intention/i, /fewest elements/i, /many small refactorings/i]), checkpoint: "guided-step"
});
const successRepair = (defect: CanonicalPatch): CanonicalPatch => ({
  name: "repair", files: { [successPath]: success }, message: "I've rewritten success.md as durable strategy. Please check it.",
  preconditions: defect.expectedState, expectedState: { [successPath]: successExpectations }, checkpoint: "correction"
});

const missingToolsDefect = defectInvoke("missing-tools");
const wrongDirectoryDefect = defectInvoke("wrong-directory");
const invalidDefect = invalidPromptDefect();
const checklistDefect = checklistSuccessDefect();

export const scenarios: Scenario[] = [
  { id: "agent-led-happy-path", lesson: "001", mode: "delegate", description: "Delegating learner completes the success criteria, doer prompt, and one-shot run script.", patches: [], finalState: lesson001FinalState },
  { id: "learner-led-happy-path", lesson: "001", mode: "hands-on", description: "Hands-on learner requests exact guidance and completes one canonical edit per required step.", patches: [successStep(), promptStep(), invokeStep()], finalState: lesson001FinalState },
  { id: "mistake-missing-tools", lesson: "001", mode: "mistake", description: "Hands-on learner omits Pi's doer tool allowlist.", expectedMistake: "The doer has lost its file-tool isolation boundary.", patches: [successStep(), promptStep(), missingToolsDefect, repairInvoke(missingToolsDefect)], finalState: lesson001FinalState },
  { id: "mistake-wrong-calculator-directory", lesson: "001", mode: "mistake", description: "Hands-on learner starts Pi outside calculator.", expectedMistake: "The doer is not scoped to the calculator directory.", patches: [successStep(), promptStep(), wrongDirectoryDefect, repairInvoke(wrongDirectoryDefect)], finalState: lesson001FinalState },
  { id: "mistake-invalid-prompt-boundary", lesson: "001", mode: "mistake", description: "Hands-on learner gives the doer validation authority.", expectedMistake: "Validation is no longer independent from the doer.", patches: [successStep(), invalidDefect, promptRepair(invalidDefect), invokeStep()], finalState: lesson001FinalState },
  { id: "mistake-success-as-refactoring-checklist", lesson: "001", mode: "mistake", description: "Hands-on learner treats success.md as a next-refactoring checklist and omits the simple-design destination.", expectedMistake: "success.md must contain all four simple-design rules as durable factory strategy, not a one-turn checklist.", patches: [checklistDefect, successRepair(checklistDefect), promptStep(), invokeStep()], finalState: lesson001FinalState }
];

export function findScenario(id: string): Scenario | undefined { return scenarios.find((scenario) => scenario.id === id); }
