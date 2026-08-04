import type { ArtifactState, CanonicalPatch, FileExpectation, Scenario } from "../lesson-001/scenarios.js";
import {
  correctDo, correctLineRun, correctValidateSh, doPath, lesson005FinalState, linePath,
  refactor, refactorPath, success, successPath, validate, validatePath, validateShPath
} from "../lesson-005/scenarios.js";

export const repairPath = "factory/refactor/repair.md";

export const repair = `The success criteria the line is working towards, and the validator's findings on the change just made, are appended below.

Make the smallest change that addresses the failed findings. Do not start a new refactoring, and do not go looking for other things worth improving.

Edit files directly. Do not run tests, npm, or shell commands. Keep your response concise.
`;

const verdictBranch = `  verdict=$(grep -m1 -o '^VERDICT: \\(PASS\\|FAIL\\)' validate-findings.txt || echo "VERDICT: FAIL")
  if [ "$verdict" = "VERDICT: FAIL" ]; then
    echo "Starting repair..."
    cat repair.md success.md validate-findings.txt \\
      | (cd ../../calculator && pi --no-session --tools read,edit,write,grep,find,ls -p)
  fi
`;

export const correctRoutingRun = correctLineRun.replace("  read -r -p", `${verdictBranch}  read -r -p`);

const unanchoredRoutingRun = correctRoutingRun.replace("'^VERDICT: ", "'VERDICT: ");
const findinglessRepairRun = correctRoutingRun.replace("cat repair.md success.md validate-findings.txt", "cat repair.md success.md");
const unreadableVerdictPassesRun = correctRoutingRun.replace(`|| echo "VERDICT: FAIL")`, `|| echo "VERDICT: PASS")`);

const routingScriptExpectations: FileExpectation = {
  exists: true,
  contains: [
    /while true; do/,
    /Recording quality baseline/,
    /Starting doer/,
    /Starting validation/,
    /tee validate-findings\.txt/,
    // The anchor and the failing fallback are the two halves of the parse's correctness.
    /grep -m1 -o '\^VERDICT: /,
    /\|\| echo "VERDICT: FAIL"/,
    /Starting repair/,
    /cat repair\.md success\.md validate-findings\.txt/,
    /read -r -p/
  ],
  excludes: [/\(cd \.\.\/calculator && /, /^\s*else$/m]
};

export const lesson006FinalState: ArtifactState = {
  ...lesson005FinalState,
  [repairPath]: { exists: true, contains: [/smallest/i, /appended below/i, /Do not run tests, npm, or shell commands/], excludes: [/success\.md/, /validate-findings\.txt/] },
  [linePath]: routingScriptExpectations
};

const contains = (path: string, patterns: RegExp[], excludes: RegExp[] = []): ArtifactState => ({ [path]: { exists: true, contains: patterns, excludes } });

/** What lesson 005 left behind: the whole line, ordered but with nothing reading its verdicts. */
const lineCarriedForward = (): CanonicalPatch => ({
  name: "carry-forward",
  files: {
    [refactorPath]: refactor, [validatePath]: validate, [successPath]: success,
    [doPath]: correctDo, [validateShPath]: correctValidateSh, [linePath]: correctLineRun
  },
  message: "I've brought the assembly line forward from the previous lesson. Please check it.",
  preconditions: { [linePath]: { exists: false } },
  expectedState: { [successPath]: { exists: true }, [linePath]: { exists: true, contains: [/while true; do/], excludes: [/repair\.md/] } },
  checkpoint: "guided-step"
});
const repairPromptStep = (): CanonicalPatch => ({
  name: "repair-prompt", files: { [repairPath]: repair },
  message: "I've written the repair prompt. Please check it.",
  preconditions: { [linePath]: { exists: true }, [repairPath]: { exists: false } },
  expectedState: { [repairPath]: lesson006FinalState[repairPath]! }, checkpoint: "guided-step"
});
const branchStep = (): CanonicalPatch => ({
  name: "branch", files: { [linePath]: correctRoutingRun },
  message: "I've added the verdict branch. Please check it.",
  preconditions: { [repairPath]: { exists: true }, [linePath]: { exists: true, excludes: [/repair\.md/] } },
  expectedState: { [linePath]: routingScriptExpectations }, checkpoint: "guided-step"
});

const branchDefect = (name: "unanchored-verdict" | "repair-without-findings" | "unreadable-verdict-passes"): CanonicalPatch => ({
  name: "defect",
  files: {
    [linePath]: name === "unanchored-verdict" ? unanchoredRoutingRun
      : name === "repair-without-findings" ? findinglessRepairRun : unreadableVerdictPassesRun
  },
  message: "I've added the verdict branch. Please give feedback.",
  preconditions: { [repairPath]: { exists: true }, [linePath]: { exists: true, excludes: [/repair\.md/] } },
  expectedState: name === "unanchored-verdict"
    ? contains(linePath, [/grep -m1 -o 'VERDICT: /], [/'\^VERDICT: /])
    : name === "repair-without-findings"
      ? contains(linePath, [/cat repair\.md success\.md \\\n/], [/cat repair\.md success\.md validate-findings\.txt/])
      : contains(linePath, [/\|\| echo "VERDICT: PASS"/], [/\|\| echo "VERDICT: FAIL"/]),
  checkpoint: "guided-step"
});
const branchRepair = (broken: CanonicalPatch): CanonicalPatch => ({
  name: "repair", files: { [linePath]: correctRoutingRun },
  message: "I've applied the smallest repair. Please check it.",
  preconditions: broken.expectedState,
  expectedState: { [linePath]: routingScriptExpectations }, checkpoint: "correction"
});

const unanchoredDefect = branchDefect("unanchored-verdict");
const findinglessDefect = branchDefect("repair-without-findings");
const passingFallbackDefect = branchDefect("unreadable-verdict-passes");

export const lesson006Scenarios: Scenario[] = [
  { id: "routing-agent-led-happy-path", lesson: "006", mode: "delegate", description: "Delegating learner adds the repair prompt and the verdict branch that selects it.", patches: [], finalState: lesson006FinalState },
  { id: "routing-learner-led-happy-path", lesson: "006", mode: "hands-on", description: "Hands-on learner writes the repair prompt, then branches the line on the verdict, one canonical edit at a time.", patches: [lineCarriedForward(), repairPromptStep(), branchStep()], finalState: lesson006FinalState },
  { id: "mistake-unanchored-verdict-parse", lesson: "006", mode: "mistake", description: "Hands-on learner drops the `^` from the verdict pattern.", expectedMistake: "The pattern now matches a verdict quoted anywhere in a sentence, so a validator that recites its own format above a failing verdict is read as a pass, and the repair the file below it asked for never runs.", patches: [lineCarriedForward(), repairPromptStep(), unanchoredDefect, branchRepair(unanchoredDefect)], finalState: lesson006FinalState },
  { id: "mistake-repair-without-findings", lesson: "006", mode: "mistake", description: "Hands-on learner invokes the repair machine without appending the validator's findings.", expectedMistake: "The repair machine is asked to answer findings it was never handed, so it has nothing to repair and falls back to guessing.", patches: [lineCarriedForward(), repairPromptStep(), findinglessDefect, branchRepair(findinglessDefect)], finalState: lesson006FinalState },
  { id: "mistake-unreadable-verdict-treated-as-pass", lesson: "006", mode: "mistake", description: "Hands-on learner makes an unreadable or missing verdict fall back to `VERDICT: PASS`.", expectedMistake: "The line now reads 'I could not tell' as 'everything is fine' and quietly refactors on top of a change nobody checked; the opposite fallback costs at most one repair turn that was not needed.", patches: [lineCarriedForward(), repairPromptStep(), passingFallbackDefect, branchRepair(passingFallbackDefect)], finalState: lesson006FinalState }
];
