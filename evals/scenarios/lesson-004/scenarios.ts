import type { Scenario } from "../lesson-001/scenarios.js";

/**
 * Lesson 004 builds nothing. The learner runs the two scripts they already have,
 * carries the findings between them by hand, and closes Part 1. With no artefact
 * to grade, these scenarios rest entirely on the model-graded judge, so each
 * description names what must be observable in the transcript and each
 * `expectedMistake` names the specific way the transcript can fail.
 */
export const lesson004Scenarios: Scenario[] = [
  {
    id: "feedback-cycle-happy-path",
    lesson: "004",
    mode: "hands-on",
    description: "The tutor walks the learner through the specification's cycle in order: run the doer and the validator until a `VERDICT: FAIL` appears, run the doer again by hand with `refactor-validate-findings.txt` appended to its prompt, then validate again and read the new verdict. It then asks the checks, and the learner can say what they personally decided, why the doer behaved differently from an unchanged prompt file, and what would happen to the cycle if they walked away.",
    patches: []
  },
  {
    id: "feedback-cycle-runs-the-doer-by-hand",
    lesson: "004",
    mode: "hands-on",
    description: "When handing the findings back, the tutor gives the learner the subshell command that pipes `refactor.md` and `refactor-validate-findings.txt` into Pi directly, and says why it is not `./factory/refactor-do.sh`: the script would re-record the baseline and throw away the 'before' the findings were written against.",
    expectedMistake: "The tutor told the learner to re-run `refactor-do.sh` to feed the findings back, which overwrites the baseline the findings were measured against.",
    patches: []
  },
  {
    id: "feedback-cycle-shows-the-loop-last",
    lesson: "004",
    mode: "hands-on",
    description: "The tutor presents the doer-and-validator diagram only after the learner has completed a cycle, and introduces it as a summary of what the learner just ran rather than as a plan for what they are about to.",
    expectedMistake: "The loop was drawn before the learner had run it, which makes it a claim the learner has to take on trust rather than a picture of something they did.",
    patches: []
  },
  {
    id: "part-boundary-offers-a-choice",
    lesson: "004",
    mode: "hands-on",
    description: "At the end of the lesson the tutor stops, recaps that Part 1 built a doer, built a validator, and ran the loop by hand, and offers an explicit choice between finishing for now and continuing into Part 2.",
    expectedMistake: "The tutor carried on into lesson 005 without the Part 1 stopping choice being offered and made explicitly.",
    patches: []
  }
];
