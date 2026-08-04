import type { ArtifactState, CanonicalPatch, Scenario } from "../lesson-001/scenarios.js";
import { correctRun, refactor, refactorPath, runPath as doerRunPath } from "../lesson-002/scenarios.js";

export const validatePath = "factory/refactor-validate.md";
export const validateRunPath = "factory/refactor-validate.sh";

export const validate = `Read the working-tree diff in the calculator and decide one thing: was the change a single refactoring, and did it reduce what \`node scripts/quality.mjs\` reports compared with the baseline included below?

Run \`node scripts/quality.mjs\` yourself and quote what it reported. Do not modify any file, and do not run shell commands that modify files.

Answer in exactly this format, with the verdict on the first non-empty line:

VERDICT: PASS

EVIDENCE:
- <what you ran, and what it reported>

The first non-empty line must be exactly \`VERDICT: PASS\` or \`VERDICT: FAIL\`.
`;

export const correctValidateRun = `#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
if [ ! -f refactor-quality-before.txt ]; then
  echo "No quality baseline. Run ./refactor-do.sh first." >&2
  exit 1
fi
echo "Starting validation..."
cat refactor-validate.md refactor-quality-before.txt \\
  | (cd ../calculator && pi --no-session --tools read,grep,find,ls,bash -p) \\
  | tee refactor-validate-findings.txt
`;

const editableValidateRun = correctValidateRun.replace("read,grep,find,ls,bash", "read,edit,write,grep,find,ls,bash");
const unguardedValidateRun = correctValidateRun.replace(/if \[ ! -f refactor-quality-before\.txt \]; then\n.*\n.*\nfi\n/, "");

export const lesson003FinalState: ArtifactState = {
  // Lesson 006's anchored `grep` rests on the first-non-empty-line promise, so
  // the prompt that makes it is asserted here rather than assumed downstream.
  [validatePath]: { exists: true, contains: [/quality\.mjs/, /baseline/, /VERDICT: PASS/, /VERDICT: FAIL/, /first non-empty line/i, /EVIDENCE/], excludes: [/edit files/i] },
  [validateRunPath]: {
    exists: true,
    contains: [/Starting validation/, /--tools read,grep,find,ls,bash -p/, /tee refactor-validate-findings\.txt/, /refactor-quality-before\.txt/],
    excludes: [/while true/, /--tools read,edit,write/]
  }
};

/**
 * What lesson 002 left behind. The specification opens by telling the learner to
 * keep it, so it is already in the workspace rather than something they retype.
 */
export const lesson002Seed: Record<string, string> = { [refactorPath]: refactor, [doerRunPath]: correctRun };

const doerCarriedForward: ArtifactState = {
  [refactorPath]: { exists: true },
  [doerRunPath]: { exists: true, contains: [/Recording quality baseline/] }
};

const promptStep = (): CanonicalPatch => ({
  name: "prompt", files: { [validatePath]: validate },
  message: "I've written the validator prompt. Please check it.",
  preconditions: { ...doerCarriedForward, [validatePath]: { exists: false } },
  expectedState: { [validatePath]: lesson003FinalState[validatePath]! }, checkpoint: "guided-step"
});
const invokeStep = (): CanonicalPatch => ({
  name: "invoke", files: { [validateRunPath]: correctValidateRun },
  message: "I've added the validator invocation. Please check it.",
  preconditions: { [validatePath]: { exists: true }, [validateRunPath]: { exists: false } },
  expectedState: lesson003FinalState, checkpoint: "guided-step"
});
const defect = (name: "editable-validator" | "missing-baseline-guard"): CanonicalPatch => ({
  name: "defect", files: { [validateRunPath]: name === "editable-validator" ? editableValidateRun : unguardedValidateRun },
  message: "I've added the validator invocation. Please give feedback.",
  preconditions: { [validatePath]: { exists: true }, [validateRunPath]: { exists: false } },
  expectedState: name === "editable-validator"
    ? { [validateRunPath]: { exists: true, contains: [/--tools read,edit,write/] } }
    : { [validateRunPath]: { exists: true, excludes: [/refactor-quality-before\.txt \]/] } },
  checkpoint: "guided-step"
});
const repair = (broken: CanonicalPatch): CanonicalPatch => ({
  name: "repair", files: { [validateRunPath]: correctValidateRun },
  message: "I've applied the smallest repair. Please check it.",
  preconditions: broken.expectedState,
  expectedState: { [validateRunPath]: lesson003FinalState[validateRunPath]! }, checkpoint: "correction"
});

const editableDefect = defect("editable-validator");
const unguardedDefect = defect("missing-baseline-guard");

export const lesson003Scenarios: Scenario[] = [
  { id: "validator-agent-led-happy-path", lesson: "003", mode: "delegate", description: "Delegating learner completes the validator prompt and its invocation.", seed: lesson002Seed, patches: [], finalState: lesson003FinalState },
  { id: "validator-learner-led-happy-path", lesson: "003", mode: "hands-on", description: "Hands-on learner writes the validator prompt and script one canonical edit at a time.", seed: lesson002Seed, patches: [promptStep(), invokeStep()], finalState: lesson003FinalState },
  { id: "mistake-validator-can-edit", lesson: "003", mode: "mistake", description: "Hands-on learner gives the validator edit and write tools.", expectedMistake: "The validator can repair what it reports on, so its evidence is no longer independent.", seed: lesson002Seed, patches: [promptStep(), editableDefect, repair(editableDefect)], finalState: lesson003FinalState },
  { id: "mistake-missing-baseline-guard", lesson: "003", mode: "mistake", description: "Hands-on learner omits the missing-baseline guard.", expectedMistake: "With no baseline on disk the validator is asked for a comparison it cannot make, and reports an improvement it never measured.", seed: lesson002Seed, patches: [promptStep(), unguardedDefect, repair(unguardedDefect)], finalState: lesson003FinalState }
];
