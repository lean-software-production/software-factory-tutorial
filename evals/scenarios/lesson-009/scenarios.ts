import type { ArtifactState, CanonicalPatch, FileExpectation, Scenario } from "../lesson-001/scenarios.js";
import { linePath } from "../lesson-005/scenarios.js";
import { rewrite } from "../rewrite.js";
import { correctBoundedRun, lesson007Seed, lesson008FinalState } from "../lesson-008/scenarios.js";

const textOf = `text_of() {
  jq -r 'select(.type=="agent_end") | .messages[]
         | select(.role=="assistant") | .content[]?
         | select(.type=="text") | .text' "$1"
}
`;

/** Every station's stdout becomes an event stream, and the two the line reads back are extracted. */
export const correctRecordingRun = [
  (source: string) => rewrite(source, 'cd "$(dirname "$0")"\n', `cd "$(dirname "$0")"\nmkdir -p events\n\n${textOf}`),
  (source: string) => rewrite(source,
    "  cat refactor.md success.md | (cd ../../calculator && pi --no-session --tools read,edit,write,grep,find,ls -p)\n",
    "  cat refactor.md success.md \\\n"
    + "    | (cd ../../calculator && pi --no-session --mode json --tools read,edit,write,grep,find,ls -p) \\\n"
    + '    > "events/$iteration-do.jsonl"\n'),
  (source: string) => rewrite(source,
    "    | (cd ../../calculator && pi --no-session --tools read,grep,find,ls -p) \\\n    | tee validate-findings.txt\n",
    "    | (cd ../../calculator && pi --no-session --mode json --tools read,grep,find,ls -p) \\\n"
    + '    > "events/$iteration-validate.jsonl"\n'
    + '  text_of "events/$iteration-validate.jsonl" > validate-findings.txt\n'),
  (source: string) => rewrite(source,
    "      | (cd ../../calculator && pi --no-session --tools read,edit,write,grep,find,ls -p)\n",
    "      | (cd ../../calculator && pi --no-session --mode json --tools read,edit,write,grep,find,ls -p) \\\n"
    + '      > "events/$iteration-repair.jsonl"\n'),
  (source: string) => rewrite(source,
    "      | (cd ../../calculator && pi --no-session --tools read,grep,find,ls -p) \\\n      > commit-message.txt\n",
    "      | (cd ../../calculator && pi --no-session --mode json --tools read,grep,find,ls -p) \\\n"
    + '      > "events/$iteration-commit.jsonl"\n'
    + '    text_of "events/$iteration-commit.jsonl" > commit-message.txt\n')
].reduce((source, step) => step(source), correctBoundedRun);

/** The record kept and the verdict still read as though it were prose. */
const rawVerdictRun = rewrite(correctRecordingRun,
  '  text_of "events/$iteration-validate.jsonl" > validate-findings.txt\n',
  '  cp "events/$iteration-validate.jsonl" validate-findings.txt\n');
/** One station recording and the rest still printing to a terminal nobody is at. */
const partialRecordRun = rewrite(correctRecordingRun,
  "    | (cd ../../calculator && pi --no-session --mode json --tools read,edit,write,grep,find,ls -p) \\\n    > \"events/$iteration-do.jsonl\"\n",
  "    | (cd ../../calculator && pi --no-session --tools read,edit,write,grep,find,ls -p)\n");
/** Every iteration writing to the same file, so only the last run survives. */
const overwritingRecordRun = correctRecordingRun.replaceAll('events/$iteration-', "events/");

const recordingRunExpectations: FileExpectation = {
  exists: true,
  contains: [
    /mkdir -p events/,
    /text_of\(\) \{/,
    /jq -r 'select\(\.type=="agent_end"\)/,
    /--mode json --tools read,edit,write,grep,find,ls -p/,
    /--mode json --tools read,grep,find,ls -p/,
    /> "events\/\$iteration-do\.jsonl"/,
    /> "events\/\$iteration-validate\.jsonl"/,
    /> "events\/\$iteration-commit\.jsonl"/,
    /text_of "events\/\$iteration-validate\.jsonl" > validate-findings\.txt/
  ],
  // Nothing on the line still reads a station's stdout as prose.
  excludes: [/tee validate-findings\.txt/, /read -r -p/]
};

export const lesson009FinalState: ArtifactState = { ...lesson008FinalState, [linePath]: recordingRunExpectations };

const contains = (path: string, patterns: RegExp[], excludes: RegExp[] = []): ArtifactState => ({ [path]: { exists: true, contains: patterns, excludes } });

/** What lesson 008 left behind: a line that runs unattended and remembers nothing. */
export const lesson008Seed: Record<string, string> = { ...lesson007Seed, [linePath]: correctBoundedRun };

const recordStep = (): CanonicalPatch => ({
  name: "record", files: { [linePath]: correctRecordingRun },
  message: "I've switched every station to --mode json, kept the events, and pulled the text back out with jq. Please check it.",
  preconditions: { [linePath]: { exists: true, contains: [/tee validate-findings\.txt/] } },
  expectedState: { [linePath]: recordingRunExpectations }, checkpoint: "guided-step"
});

const recordDefect = (name: "raw-verdict" | "partial-record" | "overwriting-record"): CanonicalPatch => ({
  name: "defect",
  files: { [linePath]: name === "raw-verdict" ? rawVerdictRun : name === "partial-record" ? partialRecordRun : overwritingRecordRun },
  message: "I've switched the line to --mode json. Please give feedback.",
  preconditions: { [linePath]: { exists: true, contains: [/tee validate-findings\.txt/] } },
  expectedState: name === "raw-verdict"
    ? contains(linePath, [/cp "events\/\$iteration-validate\.jsonl" validate-findings\.txt/], [/text_of "events\/\$iteration-validate/])
    : name === "partial-record"
      // The repair station still records, so the doer's own event file is
      // what must be missing rather than every writing station.
      ? contains(linePath, [/--mode json --tools read,grep,find,ls -p/], [/> "events\/\$iteration-do\.jsonl"/])
      : contains(linePath, [/> "events\/do\.jsonl"/], [/\$iteration-do\.jsonl/]),
  checkpoint: "guided-step"
});
const recordRepair = (broken: CanonicalPatch): CanonicalPatch => ({
  name: "repair", files: { [linePath]: correctRecordingRun },
  message: "I've applied the smallest repair. Please check it.",
  preconditions: broken.expectedState,
  expectedState: { [linePath]: recordingRunExpectations }, checkpoint: "correction"
});

const rawVerdictDefect = recordDefect("raw-verdict");
const partialDefect = recordDefect("partial-record");
const overwritingDefect = recordDefect("overwriting-record");

export const lesson009Scenarios: Scenario[] = [
  { id: "record-agent-led-happy-path", lesson: "009", mode: "delegate", description: "Delegating learner switches every station to --mode json, keeps the events, and recovers the text the line reads back.", seed: lesson008Seed, patches: [], finalState: lesson009FinalState },
  { id: "record-learner-led-happy-path", lesson: "009", mode: "hands-on", description: "Hands-on learner gives the line an events directory, switches each station to --mode json, and adds one jq helper so the verdict and the commit message still come back as text. The tutor then has them query the record for what the last run did and what it cost, and is explicit that the readable terminal was the price.", seed: lesson008Seed, patches: [recordStep()], finalState: lesson009FinalState },
  { id: "mistake-verdict-read-as-json", lesson: "009", mode: "mistake", description: "Hands-on learner records the events but copies the raw stream into the findings file.", expectedMistake: "`validate-findings.txt` now holds JSON, so the anchored grep finds no line beginning with VERDICT:, the fallback treats every iteration as a failure, and the line repairs forever without a real verdict ever being read.", seed: lesson008Seed, patches: [rawVerdictDefect, recordRepair(rawVerdictDefect)], finalState: lesson009FinalState },
  { id: "mistake-only-some-stations-recorded", lesson: "009", mode: "mistake", description: "Hands-on learner records the validator's events but leaves the doer printing prose.", expectedMistake: "The doer is the station that changes the code, so the record answers what was checked and never what was done; a partial record is worse than none, because the cost total it yields looks complete and is not.", seed: lesson008Seed, patches: [partialDefect, recordRepair(partialDefect)], finalState: lesson009FinalState },
  { id: "mistake-record-overwritten-each-iteration", lesson: "009", mode: "mistake", description: "Hands-on learner names the event files after the station only, not the iteration.", expectedMistake: "Each iteration overwrites the last, so a five-iteration run leaves the record of one — and the question the record exists to answer, what the line did while nobody watched, is the question it can no longer answer.", seed: lesson008Seed, patches: [overwritingDefect, recordRepair(overwritingDefect)], finalState: lesson009FinalState }
];
