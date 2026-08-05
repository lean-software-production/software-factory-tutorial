import type { ArtifactState, CanonicalPatch, FileExpectation, Scenario } from "../lesson-001/scenarios.js";
import { doPath, linePath, refactorPath, successPath, validatePath, validateShPath } from "../lesson-005/scenarios.js";
import {
  correctReadOnlyRun, correctReadOnlyValidateSh, lesson005Seed, lesson006FinalState, readOnlyValidate
} from "../lesson-006/scenarios.js";

export const repairPath = "factory/refactor/repair.md";
export const commitPath = "factory/refactor/commit.md";

export const repair = `The success criteria the line is working towards, and the validator's findings on the change just made, are appended below.

Make the smallest change that addresses the failed findings. Do not start a new refactoring, and do not go looking for other things worth improving.

Edit files directly. Do not run tests, npm, or shell commands. Keep your response concise.
`;

export const commit = `The success criteria the line is working towards, the validator's findings, and the evidence gathered about the change just made are appended below.

Write the commit message for that change. A subject line under 72 characters, a blank line, then two or three lines saying what changed and which success criteria it moved.

Emit only the message. No preamble, no code fences, and no sentence introducing it: what you write goes straight into the repository's history exactly as it stands.
`;

const branch = `  verdict=$(grep -m1 -o '^VERDICT: \\(PASS\\|FAIL\\)' validate-findings.txt || echo "VERDICT: FAIL")
  if [ "$verdict" = "VERDICT: FAIL" ]; then
    echo "Starting repair..."
    cat repair.md success.md validate-findings.txt \\
      | (cd ../../calculator && pi --no-session --tools read,edit,write,grep,find,ls -p)
  else
    echo "Starting commit..."
    cat commit.md success.md validate-findings.txt evidence.txt \\
      | (cd ../../calculator && pi --no-session --tools read,grep,find,ls -p) \\
      > commit-message.txt
    message="$PWD/commit-message.txt"
    (cd ../../calculator && git add -- . && git commit -q -F "$message")
  fi
`;

export const correctBranchedRun = correctReadOnlyRun.replace("  read -r -p", `${branch}  read -r -p`);

const unanchoredRun = correctBranchedRun.replace("'^VERDICT: ", "'VERDICT: ");
const findinglessRepairRun = correctBranchedRun.replace("cat repair.md success.md validate-findings.txt", "cat repair.md success.md");
const passingFallbackRun = correctBranchedRun.replace(`|| echo "VERDICT: FAIL")`, `|| echo "VERDICT: PASS")`);
/** The commit station handed a shell, so it commits itself rather than writing a message. */
const shellCommitRun = correctBranchedRun
  .replace("      | (cd ../../calculator && pi --no-session --tools read,grep,find,ls -p) \\\n      > commit-message.txt\n    message=\"$PWD/commit-message.txt\"\n    (cd ../../calculator && git add -- . && git commit -q -F \"$message\")\n",
    "      | (cd ../../calculator && pi --no-session --tools read,grep,find,ls,bash -p)\n");
/** A commit on every pass, including the failing ones. */
const alwaysCommitRun = correctBranchedRun.replace(/ {2}else\n/, "  fi\n  if true; then\n");

const branchedRunExpectations: FileExpectation = {
  exists: true,
  contains: [
    /Gathering evidence/,
    /grep -m1 -o '\^VERDICT: /,
    /\|\| echo "VERDICT: FAIL"/,
    /Starting repair/,
    /cat repair\.md success\.md validate-findings\.txt/,
    /Starting commit/,
    /cat commit\.md success\.md validate-findings\.txt evidence\.txt/,
    /> commit-message\.txt/,
    /message="\$PWD\/commit-message\.txt"/,
    /git add -- \./,
    /git commit -q -F "\$message"/,
    /read -r -p/
  ],
  // `$PWD` inside the subshell expands after its `cd`, so it would resolve to
  // `calculator/` and the commit would fail; the path must be captured first.
  excludes: [
    /\(cd \.\.\/calculator && /,
    /read,edit,write,grep,find,ls -p\) \\\n {6}> commit-message/,
    /git commit -q -F "\$PWD\//
  ]
};

export const lesson007FinalState: ArtifactState = {
  ...lesson006FinalState,
  [repairPath]: { exists: true, contains: [/smallest/i, /appended below/i, /Do not run tests, npm, or shell commands/], excludes: [/success\.md/, /validate-findings\.txt/] },
  [commitPath]: { exists: true, contains: [/subject line/i, /72/, /only the message/i, /appended below/i], excludes: [/success\.md/, /git commit/] },
  [linePath]: branchedRunExpectations
};

const contains = (path: string, patterns: RegExp[], excludes: RegExp[] = []): ArtifactState => ({ [path]: { exists: true, contains: patterns, excludes } });

/** What lesson 006 left behind: the line, with a validator that cannot run anything. */
export const lesson006Seed: Record<string, string> = {
  ...lesson005Seed,
  [validatePath]: readOnlyValidate,
  [validateShPath]: correctReadOnlyValidateSh,
  [linePath]: correctReadOnlyRun,
  "factory/refactor/evidence.txt": "=== QUALITY BEFORE (recorded before the doer ran) ===\neslint: 3 findings\n"
};

const promptsStep = (): CanonicalPatch => ({
  name: "station-prompts", files: { [repairPath]: repair, [commitPath]: commit },
  message: "I've written the repair and commit prompts. Please check them.",
  preconditions: { [linePath]: { exists: true }, [repairPath]: { exists: false }, [commitPath]: { exists: false } },
  expectedState: { [repairPath]: lesson007FinalState[repairPath]!, [commitPath]: lesson007FinalState[commitPath]! }, checkpoint: "guided-step"
});
const branchStep = (): CanonicalPatch => ({
  name: "branch", files: { [linePath]: correctBranchedRun },
  message: "I've branched the line on the verdict and added the commit station. Please check it.",
  preconditions: { [repairPath]: { exists: true }, [linePath]: { exists: true, excludes: [/repair\.md/] } },
  expectedState: { [linePath]: branchedRunExpectations }, checkpoint: "guided-step"
});

const branchDefect = (name: "unanchored" | "findingless" | "passing-fallback" | "self-committing" | "always-commits"): CanonicalPatch => ({
  name: "defect",
  files: {
    [linePath]: name === "unanchored" ? unanchoredRun
      : name === "findingless" ? findinglessRepairRun
        : name === "passing-fallback" ? passingFallbackRun
          : name === "self-committing" ? shellCommitRun : alwaysCommitRun
  },
  message: "I've branched the line on the verdict and added the commit station. Please give feedback.",
  preconditions: { [repairPath]: { exists: true }, [linePath]: { exists: true, excludes: [/repair\.md/] } },
  expectedState: name === "unanchored"
    ? contains(linePath, [/grep -m1 -o 'VERDICT: /], [/'\^VERDICT: /])
    : name === "findingless"
      ? contains(linePath, [/cat repair\.md success\.md \\\n/], [/cat repair\.md success\.md validate-findings\.txt/])
      : name === "passing-fallback"
        ? contains(linePath, [/\|\| echo "VERDICT: PASS"/], [/\|\| echo "VERDICT: FAIL"/])
        : name === "self-committing"
          ? contains(linePath, [/read,grep,find,ls,bash -p/], [/> commit-message\.txt/])
          : contains(linePath, [/if true; then/]),
  checkpoint: "guided-step"
});
const branchRepair = (broken: CanonicalPatch): CanonicalPatch => ({
  name: "repair", files: { [linePath]: correctBranchedRun },
  message: "I've applied the smallest repair. Please check it.",
  preconditions: broken.expectedState,
  expectedState: { [linePath]: branchedRunExpectations }, checkpoint: "correction"
});

const unanchoredDefect = branchDefect("unanchored");
const findinglessDefect = branchDefect("findingless");
const passingFallbackDefect = branchDefect("passing-fallback");
const selfCommittingDefect = branchDefect("self-committing");
const alwaysCommitsDefect = branchDefect("always-commits");

export const lesson007Scenarios: Scenario[] = [
  { id: "branch-agent-led-happy-path", lesson: "007", mode: "delegate", description: "Delegating learner writes the repair and commit prompts and branches the line on the verdict.", seed: lesson006Seed, patches: [], finalState: lesson007FinalState },
  { id: "branch-learner-led-happy-path", lesson: "007", mode: "hands-on", description: "Hands-on learner writes the two station prompts, then branches the line so a failure repairs and a pass commits, one canonical edit at a time.", seed: lesson006Seed, patches: [promptsStep(), branchStep()], finalState: lesson007FinalState },
  { id: "mistake-unanchored-verdict-parse", lesson: "007", mode: "mistake", description: "Hands-on learner drops the `^` from the verdict pattern.", expectedMistake: "The pattern now matches a verdict quoted anywhere in a sentence, so a validator that recites its own format above a failing verdict is read as a pass — and the line does not merely skip the repair, it commits the change it was told had failed.", seed: lesson006Seed, patches: [promptsStep(), unanchoredDefect, branchRepair(unanchoredDefect)], finalState: lesson007FinalState },
  { id: "mistake-repair-without-findings", lesson: "007", mode: "mistake", description: "Hands-on learner invokes the repair machine without appending the validator's findings.", expectedMistake: "The repair machine is asked to answer findings it was never handed, so it has nothing to repair and falls back to guessing.", seed: lesson006Seed, patches: [promptsStep(), findinglessDefect, branchRepair(findinglessDefect)], finalState: lesson007FinalState },
  { id: "mistake-unreadable-verdict-treated-as-pass", lesson: "007", mode: "mistake", description: "Hands-on learner makes an unreadable or missing verdict fall back to `VERDICT: PASS`.", expectedMistake: "The line now reads 'I could not tell' as 'everything is fine', commits a change nobody checked, and does it quietly; the opposite fallback costs at most one repair turn that was not needed.", seed: lesson006Seed, patches: [promptsStep(), passingFallbackDefect, branchRepair(passingFallbackDefect)], finalState: lesson007FinalState },
  { id: "mistake-commit-station-given-a-shell", lesson: "007", mode: "mistake", description: "Hands-on learner hands the commit station `bash` and lets it run git itself.", expectedMistake: "Staging and committing are not judgement and needed no model, and a station that writes history is a much larger boundary than one that writes text — the split between the model call and the deterministic step is the point of this station.", seed: lesson006Seed, patches: [promptsStep(), selfCommittingDefect, branchRepair(selfCommittingDefect)], finalState: lesson007FinalState },
  { id: "mistake-commits-on-every-verdict", lesson: "007", mode: "mistake", description: "Hands-on learner commits on both arms of the branch instead of only on a pass.", expectedMistake: "A failing verdict now produces a commit too, so the verdict has no consequence beyond which prompt runs next, and `git log` stops being a record of what the line got right.", seed: lesson006Seed, patches: [promptsStep(), alwaysCommitsDefect, branchRepair(alwaysCommitsDefect)], finalState: lesson007FinalState }
];
