import type { ArtifactState, CanonicalPatch, FileExpectation, Scenario } from "../lesson-001/scenarios.js";
import { linePath } from "../lesson-005/scenarios.js";
import { rewrite } from "../rewrite.js";
import {
  commit, commitPath, correctBranchedRun, lesson006Seed, lesson007FinalState, repair, repairPath
} from "../lesson-007/scenarios.js";

/** The counters, the loop bound, the give-up rule, and the ending the learner is told about. */
export const correctBoundedRun = [
  (source: string) => rewrite(source, 'cd "$(dirname "$0")"\nwhile true; do\n',
    'cd "$(dirname "$0")"\n\nmax_iterations=5\niteration=0\nconsecutive_failures=0\n\n'
    + 'while [ "$iteration" -lt "$max_iterations" ]; do\n  iteration=$((iteration + 1))\n'
    + '  echo "=== Iteration $iteration of $max_iterations ==="\n'),
  (source: string) => rewrite(source, '    echo "Starting repair..."',
    '    consecutive_failures=$((consecutive_failures + 1))\n    echo "Starting repair..."'),
  (source: string) => rewrite(source, '    echo "Starting commit..."',
    '    consecutive_failures=0\n    echo "Starting commit..."'),
  (source: string) => rewrite(source, / {2}read -r -p .*\ndone\n/,
    '  if [ "$consecutive_failures" -ge 2 ]; then\n    echo "Stopping: two failing verdicts in a row."\n    break\n  fi\ndone\n'
    + 'echo "Line finished after $iteration iterations."\n')
].reduce((source, step) => step(source), correctBranchedRun);

/** The pause gone and nothing put in its place: a loop with no way to end. */
const unboundedRun = rewrite(correctBoundedRun, /max_iterations=5\niteration=0\n/, "iteration=0\n")
  .replace('while [ "$iteration" -lt "$max_iterations" ]; do', "while true; do")
  .replace('  echo "=== Iteration $iteration of $max_iterations ==="', '  echo "=== Iteration $iteration ==="');
/** The counter never reset, so it counts failures rather than consecutive ones. */
const unresetCounterRun = rewrite(correctBoundedRun, "    consecutive_failures=0\n", "");
/** A silent ending: the loop stops and nobody who was not watching finds out. */
const silentEndingRun = rewrite(correctBoundedRun, /echo "Line finished after \$iteration iterations\."\n/, "");

const boundedRunExpectations: FileExpectation = {
  exists: true,
  contains: [
    /max_iterations=/,
    /iteration=\$\(\(iteration \+ 1\)\)/,
    /consecutive_failures=\$\(\(consecutive_failures \+ 1\)\)/,
    /consecutive_failures=0/,
    /-ge 2/,
    /break/,
    /Line finished after/,
    /Starting repair/,
    /Starting commit/
  ],
  // The whole lesson is the absence of this line.
  excludes: [/read -r -p/, /while true; do/]
};

export const lesson008FinalState: ArtifactState = { ...lesson007FinalState, [linePath]: boundedRunExpectations };

const contains = (path: string, patterns: RegExp[], excludes: RegExp[] = []): ArtifactState => ({ [path]: { exists: true, contains: patterns, excludes } });

/** What lesson 007 left behind: a branching line that still stops for a person. */
export const lesson007Seed: Record<string, string> = {
  ...lesson006Seed,
  [repairPath]: repair,
  [commitPath]: commit,
  [linePath]: correctBranchedRun
};

const boundStep = (): CanonicalPatch => ({
  name: "stop-condition", files: { [linePath]: correctBoundedRun },
  message: "I've taken the pause off and given the line two reasons to stop. Please check it.",
  preconditions: { [linePath]: { exists: true, contains: [/read -r -p/] } },
  expectedState: { [linePath]: boundedRunExpectations }, checkpoint: "guided-step"
});

const boundDefect = (name: "unbounded" | "unreset-counter" | "silent-ending"): CanonicalPatch => ({
  name: "defect",
  files: { [linePath]: name === "unbounded" ? unboundedRun : name === "unreset-counter" ? unresetCounterRun : silentEndingRun },
  message: "I've taken the pause off. Please give feedback.",
  preconditions: { [linePath]: { exists: true, contains: [/read -r -p/] } },
  expectedState: name === "unbounded"
    ? contains(linePath, [/while true; do/], [/read -r -p/, /max_iterations/])
    : name === "unreset-counter"
      // The initialisation above the loop is also `consecutive_failures=0`,
      // so only the indented reset inside the passing arm may be missing.
      ? contains(linePath, [/consecutive_failures=\$\(\(/], [/ {4}consecutive_failures=0/])
      : contains(linePath, [/break/], [/Line finished after/]),
  checkpoint: "guided-step"
});
const boundRepair = (broken: CanonicalPatch): CanonicalPatch => ({
  name: "repair", files: { [linePath]: correctBoundedRun },
  message: "I've applied the smallest repair. Please check it.",
  preconditions: broken.expectedState,
  expectedState: { [linePath]: boundedRunExpectations }, checkpoint: "correction"
});

const unboundedDefect = boundDefect("unbounded");
const unresetDefect = boundDefect("unreset-counter");
const silentDefect = boundDefect("silent-ending");

export const lesson008Scenarios: Scenario[] = [
  { id: "unattended-agent-led-happy-path", lesson: "008", mode: "delegate", description: "Delegating learner removes the Enter pause and gives the orchestrator a ceiling and a give-up rule.", seed: lesson007Seed, patches: [], finalState: lesson008FinalState },
  { id: "unattended-learner-led-happy-path", lesson: "008", mode: "hands-on", description: "Hands-on learner chooses two stopping conditions, counts iterations and consecutive failures, deletes the pause, and has the line say how it ended.", seed: lesson007Seed, patches: [boundStep()], finalState: lesson008FinalState },
  { id: "mistake-loop-with-no-ending", lesson: "008", mode: "mistake", description: "Hands-on learner removes the pause without adding any stopping condition.", expectedMistake: "The pause was the only thing ending this loop, so removing it leaves a line that refactors the calculator forever and spends money doing it — the orchestrator's job includes deciding when the line is finished, and nothing here does.", seed: lesson007Seed, patches: [unboundedDefect, boundRepair(unboundedDefect)], finalState: lesson008FinalState },
  { id: "mistake-failure-counter-never-resets", lesson: "008", mode: "mistake", description: "Hands-on learner increments the failure counter but never resets it on a passing verdict.", expectedMistake: "The variable now counts every failure rather than consecutive ones, so a line that fails, succeeds, and fails again stops for a reason that never happened — and a line making steady progress with occasional failures gives up on itself.", seed: lesson007Seed, patches: [unresetDefect, boundRepair(unresetDefect)], finalState: lesson008FinalState },
  { id: "mistake-line-ends-silently", lesson: "008", mode: "mistake", description: "Hands-on learner stops the loop without reporting how it ended.", expectedMistake: "Nobody was watching, so a run that hit its ceiling and a run that gave up after two failures look identical afterwards; the script saying which is the only way anyone finds out.", seed: lesson007Seed, patches: [silentDefect, boundRepair(silentDefect)], finalState: lesson008FinalState }
];
