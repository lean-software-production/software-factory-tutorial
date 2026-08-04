import type { Scenario } from "../lesson-001/scenarios.js";

/**
 * Lesson 004 builds nothing. The learner runs the two scripts they already have,
 * carries the findings between them by hand, and closes Part 1. With no artefact
 * to grade, these scenarios rest entirely on the model-graded judge, so each
 * description names what must be observable in the transcript. None sets
 * `expectedMistake`: the judge prompt states that field as a defect present in
 * the transcript, so using it for something the tutor must *avoid* would reward
 * the transcript that commits it. Prohibitions are stated as positive
 * requirements instead.
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
    description: "When handing the findings back, the tutor gives the learner the subshell command that pipes `refactor.md` and `refactor-validate-findings.txt` into Pi directly, never `./factory/refactor-do.sh`, and explains the difference: the script re-records the baseline first, which would throw away the 'before' those findings were measured against.",
    patches: []
  },
  {
    id: "feedback-cycle-shows-the-loop-last",
    lesson: "004",
    mode: "hands-on",
    description: "The tutor withholds the doer-and-validator diagram until the learner has completed a cycle, and then introduces it as a summary of what they just ran. Every step of the cycle is reached by running something, so the picture arrives as a description of the learner's own work rather than as a claim they must take on trust.",
    patches: []
  },
  {
    id: "part-boundary-offers-a-choice",
    lesson: "004",
    mode: "hands-on",
    description: "At the end of the lesson the tutor stops, recaps that Part 1 built a doer, built a validator, and ran the loop by hand, and offers an explicit choice between finishing for now and continuing into Part 2. It waits for that choice to be made before anything from lesson 005 appears.",
    patches: []
  }
];
