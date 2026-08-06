import type { ArtifactState, CanonicalPatch, FileExpectation, Scenario } from "../lesson-001/scenarios.js";
import { linePath } from "../lesson-005/scenarios.js";
import { rewrite } from "../rewrite.js";
import { correctRecordingRun } from "../lesson-009/scenarios.js";
import { correctWatch, watchPath } from "../lesson-010/scenarios.js";
import { askPath, correctAsk, lesson010Seed, lesson011FinalState } from "../lesson-011/scenarios.js";

export const steerPath = "factory/steer.sh";

const cleanup = `cleanup() {
  [ -n "\${holder:-}" ] && kill "$holder" 2>/dev/null || true
  [ -n "\${doer:-}" ] && kill "$doer" 2>/dev/null || true
  rm -f control
}
trap cleanup EXIT

`;

const steerableDoer = `  echo "Starting doer..."
  rm -f control
  mkfifo control
  (cd ../../calculator && pi --no-session --mode rpc \\
      --tools read,edit,write,grep,find,ls) \\
    < control > "events/$iteration-do.jsonl" &
  doer=$!
  sleep infinity > control &
  holder=$!
  jq -cn --arg m "$(cat refactor.md success.md)" '{type:"prompt",message:$m}' > control
  until grep -q '"type":"agent_end"' "events/$iteration-do.jsonl"; do sleep 1; done
  kill "$holder" "$doer" 2>/dev/null || true
  rm -f control
`;

/** One station keeps a command channel; the other three still run to completion and exit. */
export const correctSteerableRun = [
  (source: string) => rewrite(source, "mkdir -p events\n\n", `mkdir -p events\n\n${cleanup}`),
  (source: string) => rewrite(source,
    '  echo "Starting doer..."\n  cat refactor.md success.md \\\n'
    + "    | (cd ../../calculator && pi --no-session --mode json --tools read,edit,write,grep,find,ls -p) \\\n"
    + '    > "events/$iteration-do.jsonl"\n',
    steerableDoer)
].reduce((source, step) => step(source), correctRecordingRun);

export const correctSteer = `#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
line="\${1:?usage: steer.sh <line> <message>}"
shift

jq -cn --arg m "$*" '{type:"steer",message:$m}' > "$line"/control
`;

/** The watcher extended so a steered question's answer has somewhere to appear. */
export const correctReplyingWatch = rewrite(correctWatch,
  `  | jq -r --unbuffered '
      select(.type=="tool_execution_start")
      | "→ \\(.toolName) \\(.args.command // .args.path // "")"'
`,
  `  | jq -rj --unbuffered '
      if .type=="tool_execution_start" then "\\n→ \\(.toolName)\\n"
      elif .type=="message_update" and .assistantMessageEvent.type=="text_delta"
        then .assistantMessageEvent.delta
      else empty end'
`);

/** No holder, so the station sees EOF the moment the prompt is written and exits. */
const unheldRun = rewrite(correctSteerableRun, "  sleep infinity > control &\n  holder=$!\n", "");
/** No trap, so a Ctrl-C leaves a model process and a sleep running. */
const untrappedRun = rewrite(correctSteerableRun, cleanup, "");
/** Pretty-printed, so one command arrives as eight lines and none of them parses. */
const prettyPrintedRun = rewrite(correctSteerableRun, "jq -cn --arg m", "jq -n --arg m");
/** The message hand-rolled into JSON, which the first apostrophe breaks. */
const handRolledSteer = rewrite(correctSteer,
  `jq -cn --arg m "$*" '{type:"steer",message:$m}' > "$line"/control\n`,
  `echo "{\\"type\\":\\"steer\\",\\"message\\":\\"$*\\"}" > "$line"/control\n`);

const steerableRunExpectations: FileExpectation = {
  exists: true,
  contains: [/mkfifo control/, /--mode rpc/, /sleep infinity > control &/, /trap cleanup EXIT/, /jq -cn --arg m/, /agent_end/, /kill "\$holder"/],
  // The steered station stays alive, so it takes no -p.
  excludes: [/--mode rpc \\\n {6}--tools read,edit,write,grep,find,ls -p/]
};
// `-c` is load-bearing: the channel is JSONL, and jq pretty-prints by default.
const steerExpectations: FileExpectation = { exists: true, contains: [/jq -cn --arg m/, /type":"steer|type:"steer/, /control/], excludes: [/echo "\{/, /jq -n --arg m/] };

export const lesson012FinalState: ArtifactState = {
  ...lesson011FinalState,
  [linePath]: steerableRunExpectations,
  [steerPath]: steerExpectations,
  [watchPath]: { exists: true, contains: [/tail -f/, /--unbuffered/, /text_delta/] }
};

const contains = (path: string, patterns: RegExp[], excludes: RegExp[] = []): ArtifactState => ({ [path]: { exists: true, contains: patterns, excludes } });

/** What lesson 011 left behind: a recorded, watchable, questionable line that cannot be spoken to. */
export const lesson011Seed: Record<string, string> = { ...lesson010Seed, [askPath]: correctAsk };

const channelStep = (): CanonicalPatch => ({
  name: "command-channel", files: { [linePath]: correctSteerableRun },
  message: "I've put the doer on a command channel, with a holder and a trap. Please check it.",
  preconditions: { [askPath]: { exists: true }, [linePath]: { exists: true, excludes: [/mkfifo/] } },
  expectedState: { [linePath]: steerableRunExpectations }, checkpoint: "guided-step"
});
const steerStep = (): CanonicalPatch => ({
  name: "steerer", files: { [steerPath]: correctSteer, [watchPath]: correctReplyingWatch },
  message: "I've written the steering tool and extended the watcher so replies show up. Please check it.",
  preconditions: { [linePath]: { exists: true, contains: [/mkfifo/] }, [steerPath]: { exists: false } },
  expectedState: { [steerPath]: steerExpectations, [watchPath]: { exists: true, contains: [/text_delta/] } }, checkpoint: "guided-step"
});

const channelDefect = (name: "unheld" | "untrapped" | "pretty-printed" | "hand-rolled"): CanonicalPatch => ({
  name: "defect",
  files: name === "hand-rolled"
    ? { [steerPath]: handRolledSteer }
    : { [linePath]: name === "unheld" ? unheldRun : name === "untrapped" ? untrappedRun : prettyPrintedRun },
  message: "I've put the doer on a command channel. Please give feedback.",
  preconditions: name === "hand-rolled"
    ? { [linePath]: { exists: true, contains: [/mkfifo/] }, [steerPath]: { exists: false } }
    : { [askPath]: { exists: true }, [linePath]: { exists: true, excludes: [/mkfifo/] } },
  expectedState: name === "unheld"
    ? contains(linePath, [/mkfifo control/], [/sleep infinity/])
    : name === "untrapped"
      ? contains(linePath, [/mkfifo control/], [/trap cleanup EXIT/])
      : name === "pretty-printed"
        ? contains(linePath, [/jq -n --arg m/], [/jq -cn --arg m/])
        : contains(steerPath, [/echo "\{/], [/jq -cn --arg m/]),
  checkpoint: "guided-step"
});
/**
 * The repair lands the whole lesson, not only the file that was wrong. Two of
 * these chains never reach the steering step, and a repair that fixed the fifo
 * and left the learner without `steer.sh` would end the lesson half-built.
 */
const channelRepair = (broken: CanonicalPatch): CanonicalPatch => ({
  name: "repair",
  files: { [linePath]: correctSteerableRun, [steerPath]: correctSteer, [watchPath]: correctReplyingWatch },
  message: "I've applied the smallest repair. Please check it.",
  preconditions: broken.expectedState,
  expectedState: { [linePath]: steerableRunExpectations, [steerPath]: steerExpectations },
  checkpoint: "correction"
});

const unheldDefect = channelDefect("unheld");
const untrappedDefect = channelDefect("untrapped");
const prettyPrintedDefect = channelDefect("pretty-printed");
const handRolledDefect = channelDefect("hand-rolled");

export const lesson012Scenarios: Scenario[] = [
  { id: "steer-agent-led-happy-path", lesson: "012", mode: "delegate", description: "Delegating learner puts the doer on a command channel and adds the tool that speaks to it.", seed: lesson011Seed, patches: [], finalState: lesson012FinalState },
  { id: "steer-learner-led-happy-path", lesson: "012", mode: "hands-on", description: "Hands-on learner gives the doer a fifo and rpc mode, holds the channel open, traps the cleanup, then writes `factory/steer.sh` and extends the watcher so a steered question's answer appears. The tutor is explicit that the three terminals are what keep this in shell, and that the holder is the smallest possible daemon.", seed: lesson011Seed, patches: [channelStep(), steerStep()], finalState: lesson012FinalState },
  { id: "mistake-channel-not-held-open", lesson: "012", mode: "mistake", description: "Hands-on learner opens the fifo without a process holding it open.", expectedMistake: "A fifo returns end-of-file when its last writer closes, so the station exits the moment the prompt has been written and does no work at all — the holder is the whole reason a long-running station stays alive between commands.", seed: lesson011Seed, patches: [unheldDefect, channelRepair(unheldDefect)], finalState: lesson012FinalState },
  { id: "mistake-no-cleanup-trap", lesson: "012", mode: "mistake", description: "Hands-on learner leaves the background processes and the fifo without a trap.", expectedMistake: "Every earlier station exited on its own when its work was done; this one exits when something tells it to, so a Ctrl-C out of the run leaves a model process and a sleep running on the learner's machine with nothing left to stop them.", seed: lesson011Seed, patches: [untrappedDefect, channelRepair(untrappedDefect)], finalState: lesson012FinalState },
  { id: "mistake-command-is-pretty-printed", lesson: "012", mode: "mistake", description: "Hands-on learner builds the prompt command with jq's default pretty-printed output.", expectedMistake: "The channel is JSONL and its reader splits on newlines, so one pretty-printed command arrives as eight lines and not one of them parses as a whole object; the station waits forever for an instruction it has already been given, and prints nothing while it waits.", seed: lesson011Seed, patches: [prettyPrintedDefect, channelRepair(prettyPrintedDefect)], finalState: lesson012FinalState },
  { id: "mistake-hand-rolled-steer-json", lesson: "012", mode: "mistake", description: "Hands-on learner builds the steering command with `echo` instead of jq.", expectedMistake: "The first message anyone actually wants to send contains an apostrophe or a quote, and a hand-rolled JSON string turns it into a parse error the station discards silently rather than a steer — jq builds the command for the same reason it reads the events.", seed: lesson011Seed, patches: [channelStep(), handRolledDefect, channelRepair(handRolledDefect)], finalState: lesson012FinalState }
];
