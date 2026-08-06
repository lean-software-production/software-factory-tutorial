import type { ArtifactState, CanonicalPatch, FileExpectation, Scenario } from "../lesson-001/scenarios.js";
import { linePath } from "../lesson-005/scenarios.js";
import { correctRecordingRun, lesson008Seed, lesson009FinalState } from "../lesson-009/scenarios.js";

export const watchPath = "factory/watch.sh";

/**
 * The watcher sits above the line, not inside it: it can watch any line, so it
 * takes the line's name rather than knowing one.
 */
export const correctWatch = `#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
line="\${1:?usage: watch.sh <line>}"

tail -f -n +1 "$line"/events/*.jsonl \\
  | jq -r --unbuffered '
      select(.type=="tool_execution_start")
      | "→ \\(.toolName) \\(.args.command // .args.path // "")"'
`;

/** Inside the line's folder, where a second line could never reach it. */
const insideTheLineWatch = correctWatch
  .replace('line="${1:?usage: watch.sh <line>}"\n\n', "")
  .replace('tail -f -n +1 "$line"/events/*.jsonl', "tail -f -n +1 events/*.jsonl");
/** Reads the record once and stops, which is the lesson's one new idea removed. */
const notLiveWatch = correctWatch.replace("tail -f -n +1 ", "cat ");
/** Buffered, so nothing appears until jq's buffer fills or the line ends. */
const bufferedWatch = correctWatch.replace(" --unbuffered", "");

const watchExpectations: FileExpectation = {
  exists: true,
  contains: [/tail -f/, /--unbuffered/, /\$\{?1/, /tool_execution_start/, /jq/],
  excludes: [/pi /]
};

export const lesson010FinalState: ArtifactState = { ...lesson009FinalState, [watchPath]: watchExpectations };

const contains = (path: string, patterns: RegExp[], excludes: RegExp[] = []): ArtifactState => ({ [path]: { exists: true, contains: patterns, excludes } });

/** What lesson 009 left behind: a line that records everything and shows nothing. */
export const lesson009Seed: Record<string, string> = {
  ...lesson008Seed,
  [linePath]: correctRecordingRun,
  "factory/refactor/events/1-validate.jsonl": `{"type":"agent_start"}
{"type":"tool_execution_start","toolCallId":"call_1","toolName":"read","args":{"path":"src/calc.ts"}}
{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"VERDICT: PASS\\n"}],"usage":{"cost":{"total":0.002}}}}
{"type":"agent_end","messages":[{"role":"assistant","content":[{"type":"text","text":"VERDICT: PASS\\n"}]}]}
`
};

const watchStep = (): CanonicalPatch => ({
  name: "watcher", files: { [watchPath]: correctWatch },
  message: "I've written the watcher, above the line rather than inside it. Please check it.",
  preconditions: { [linePath]: { exists: true }, [watchPath]: { exists: false } },
  expectedState: { [watchPath]: watchExpectations }, checkpoint: "guided-step"
});

const watchDefect = (name: "inside-the-line" | "not-live" | "buffered"): CanonicalPatch => ({
  name: "defect",
  files: name === "inside-the-line"
    ? { "factory/refactor/watch.sh": insideTheLineWatch }
    : { [watchPath]: name === "not-live" ? notLiveWatch : bufferedWatch },
  message: "I've written the watcher. Please give feedback.",
  preconditions: { [linePath]: { exists: true }, [watchPath]: { exists: false } },
  expectedState: name === "inside-the-line"
    ? { "factory/refactor/watch.sh": { exists: true }, [watchPath]: { exists: false } }
    : name === "not-live"
      ? contains(watchPath, [/cat "\$line"\/events/], [/tail -f/])
      : contains(watchPath, [/tail -f/], [/--unbuffered/]),
  checkpoint: "guided-step"
});
const watchRepair = (broken: CanonicalPatch): CanonicalPatch => ({
  name: "repair", files: { [watchPath]: correctWatch, "factory/refactor/watch.sh": null },
  message: "I've applied the smallest repair. Please check it.",
  preconditions: broken.expectedState,
  expectedState: { [watchPath]: watchExpectations }, checkpoint: "correction"
});

const insideDefect = watchDefect("inside-the-line");
const notLiveDefect = watchDefect("not-live");
const bufferedDefect = watchDefect("buffered");

export const lesson010Scenarios: Scenario[] = [
  { id: "watch-agent-led-happy-path", lesson: "010", mode: "delegate", description: "Delegating learner writes a watcher above the line that follows the record as it grows.", seed: lesson009Seed, patches: [], finalState: lesson010FinalState },
  { id: "watch-learner-led-happy-path", lesson: "010", mode: "hands-on", description: "Hands-on learner writes `factory/watch.sh`, runs the line in one terminal and the watcher in another, and can say why nothing inside the line had to change to permit watching.", seed: lesson009Seed, patches: [watchStep()], finalState: lesson010FinalState },
  { id: "mistake-watcher-inside-the-line", lesson: "010", mode: "mistake", description: "Hands-on learner puts the watcher inside `factory/refactor/` with the line's path hard-coded.", expectedMistake: "The watcher operates a factory rather than belonging to a line, and hard-coding the line means a second line would need a second copy — the difference between what runs a line and what watches one is exactly what the folder layout is for.", seed: lesson009Seed, patches: [insideDefect, watchRepair(insideDefect)], finalState: lesson010FinalState },
  { id: "mistake-watcher-is-not-live", lesson: "010", mode: "mistake", description: "Hands-on learner reads the record with `cat` instead of following it.", expectedMistake: "Reading a file once is what lesson 009 already did; the one new idea here is reading it as it grows, and without it the run they most want to see is still the one they cannot.", seed: lesson009Seed, patches: [notLiveDefect, watchRepair(notLiveDefect)], finalState: lesson010FinalState },
  { id: "mistake-watcher-buffers", lesson: "010", mode: "mistake", description: "Hands-on learner omits `--unbuffered` from the watcher's jq.", expectedMistake: "jq holds its output until its buffer fills, so a live watcher shows nothing for a long stretch and then everything at once — which is a slower version of reading the file afterwards, not a view of the run.", seed: lesson009Seed, patches: [bufferedDefect, watchRepair(bufferedDefect)], finalState: lesson010FinalState }
];
