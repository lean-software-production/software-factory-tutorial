import type { ArtifactState, CanonicalPatch, FileExpectation, Scenario } from "../lesson-001/scenarios.js";
import { linePath } from "../lesson-005/scenarios.js";
import { correctWatch, lesson009Seed, lesson010FinalState, watchPath } from "../lesson-010/scenarios.js";

export const askPath = "factory/ask.sh";

/** Lesson 001's command, pointed at the line's own record instead of the calculator. */
export const correctAsk = `#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
line="\${1:?usage: ask.sh <line> <question>}"
shift

{
  echo "$*"
  echo
  echo "Below is the record of the most recent run of the '$line' assembly line."
  echo "Each line is one JSON event. Answer only from what is in it."
  echo
  jq -c 'select(.type=="tool_execution_start" or .type=="message_end")' \\
    "$line"/events/*.jsonl
} | pi --no-session --no-tools -p
`;

/** Tools it does not need, and a boundary it has no reason to hold. */
const toolledAsk = correctAsk.replace("--no-session --no-tools -p", "--no-session --tools read,grep,find,ls,bash -p");
/** The whole record, unfiltered, most of it streaming fragments of messages repeated whole below. */
const unfilteredAsk = correctAsk.replace(
  "  jq -c 'select(.type==\"tool_execution_start\" or .type==\"message_end\")' \\\n    \"$line\"/events/*.jsonl\n",
  '  cat "$line"/events/*.jsonl\n');
/** Evidence first and the question last, which is not the order any station on this line expects. */
const questionLastAsk = correctAsk
  .replace('  echo "$*"\n  echo\n', "")
  .replace('    "$line"/events/*.jsonl\n', '    "$line"/events/*.jsonl\n  echo\n  echo "$*"\n');

const askExpectations: FileExpectation = {
  exists: true,
  contains: [/--no-tools/, /jq -c 'select\(/, /\$\{?1/, /pi --no-session/],
  // Everything it works from is handed to it; it never reaches for anything.
  excludes: [/--tools/, /cd \.\.\/calculator/]
};

export const lesson011FinalState: ArtifactState = { ...lesson010FinalState, [askPath]: askExpectations };

const contains = (path: string, patterns: RegExp[], excludes: RegExp[] = []): ArtifactState => ({ [path]: { exists: true, contains: patterns, excludes } });

/** What lesson 010 left behind: a line with a record and a live view of it. */
export const lesson010Seed: Record<string, string> = { ...lesson009Seed, [watchPath]: correctWatch };

const askStep = (): CanonicalPatch => ({
  name: "asker", files: { [askPath]: correctAsk },
  message: "I've written the asker: lesson 001's command pointed at the line's record. Please check it.",
  preconditions: { [watchPath]: { exists: true }, [askPath]: { exists: false } },
  expectedState: { [askPath]: askExpectations }, checkpoint: "guided-step"
});

const askDefect = (name: "given-tools" | "unfiltered" | "question-last"): CanonicalPatch => ({
  name: "defect",
  files: { [askPath]: name === "given-tools" ? toolledAsk : name === "unfiltered" ? unfilteredAsk : questionLastAsk },
  message: "I've written the asker. Please give feedback.",
  preconditions: { [watchPath]: { exists: true }, [askPath]: { exists: false } },
  expectedState: name === "given-tools"
    ? contains(askPath, [/--tools read,grep,find,ls,bash/], [/--no-tools/])
    : name === "unfiltered"
      ? contains(askPath, [/cat "\$line"\/events/], [/jq -c 'select\(/])
      : contains(askPath, [/events\/\*\.jsonl\n {2}echo\n {2}echo "\$\*"/]),
  checkpoint: "guided-step"
});
const askRepair = (broken: CanonicalPatch): CanonicalPatch => ({
  name: "repair", files: { [askPath]: correctAsk },
  message: "I've applied the smallest repair. Please check it.",
  preconditions: broken.expectedState,
  expectedState: { [askPath]: askExpectations }, checkpoint: "correction"
});

const toolledDefect = askDefect("given-tools");
const unfilteredDefect = askDefect("unfiltered");
const questionLastDefect = askDefect("question-last");

export const lesson011Scenarios: Scenario[] = [
  { id: "ask-agent-led-happy-path", lesson: "011", mode: "delegate", description: "Delegating learner writes an asker that reads the line's record and answers questions about it.", seed: lesson010Seed, patches: [], finalState: lesson011FinalState },
  { id: "ask-learner-led-happy-path", lesson: "011", mode: "hands-on", description: "Hands-on learner writes `factory/ask.sh`, and the tutor draws the line back to lesson 001: the same harness, the same job on stdin, the same read-only boundary, pointed at the factory's own record. It has them ask something jq cannot answer and check one answer against the record by hand.", seed: lesson010Seed, patches: [askStep()], finalState: lesson011FinalState },
  { id: "mistake-asker-given-tools", lesson: "011", mode: "mistake", description: "Hands-on learner gives the asker a toolset including bash.", expectedMistake: "Everything the asker works from already arrives on stdin, so the tools buy nothing and cost a boundary: an agent asked what a run did can now go and run things itself, and its answer stops being a reading of the record.", seed: lesson010Seed, patches: [toolledDefect, askRepair(toolledDefect)], finalState: lesson011FinalState },
  { id: "mistake-record-unfiltered", lesson: "011", mode: "mistake", description: "Hands-on learner pipes the whole record in without filtering it.", expectedMistake: "Most of a run's event lines are streaming fragments of messages that also appear whole further down, so an unfiltered record is many times larger than it needs to be and a real run will not fit in the model's context at all.", seed: lesson010Seed, patches: [unfilteredDefect, askRepair(unfilteredDefect)], finalState: lesson011FinalState },
  { id: "mistake-question-after-the-evidence", lesson: "011", mode: "mistake", description: "Hands-on learner appends the question after the record instead of before it.", expectedMistake: "Every station on this line takes its job first and its inputs after, and the asker is the one place that order is easy to reverse; a question buried under thousands of event lines is a different prompt from the same question at the top.", seed: lesson010Seed, patches: [questionLastDefect, askRepair(questionLastDefect)], finalState: lesson011FinalState }
];
