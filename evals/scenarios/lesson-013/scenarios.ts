import type { Scenario } from "../lesson-001/scenarios.js";
import { linePath } from "../lesson-005/scenarios.js";
import { correctReplyingWatch, correctSteer, correctSteerableRun, lesson011Seed, steerPath } from "../lesson-012/scenarios.js";
import { watchPath } from "../lesson-010/scenarios.js";

/**
 * The whole factory as lesson 012 leaves it. Lesson 013 builds nothing: it names
 * what is already on disk and is precise about what is left. With no artefact to
 * grade, these scenarios rest entirely on the model-graded judge, so each
 * description names what must be observable in the transcript.
 *
 * None sets `expectedMistake`. The judge prompt states that field as a defect
 * present in the transcript, so using it for something the tutor must *avoid*
 * would reward the transcript that commits it. Prohibitions are stated as
 * positive requirements instead — most of all the one that matters here: this
 * lesson must not hand the learner anything.
 */
export const lesson012Seed: Record<string, string> = {
  ...lesson011Seed,
  [linePath]: correctSteerableRun,
  [steerPath]: correctSteer,
  [watchPath]: correctReplyingWatch
};

export const lesson013Scenarios: Scenario[] = [
  {
    id: "oversight-names-what-is-already-built",
    lesson: "013",
    mode: "hands-on",
    seed: lesson012Seed,
    description: "The tutor names the orchestrator as `factory/refactor/run.sh` and points at the specific lines doing each of the role's jobs — the branch from lesson 007, the stopping conditions from 008, the `cat` in front of every station — rather than describing the role in the abstract. It is explicit that the learner wrote all of it, and that nothing is being introduced.",
    patches: []
  },
  {
    id: "oversight-distinguishes-factory-from-line",
    lesson: "013",
    mode: "hands-on",
    seed: lesson012Seed,
    description: "The tutor draws the distinction between the assembly line in `factory/refactor/` and the factory in `factory/`, and grounds it in the layout: the three operating scripts take a line's name as an argument and would work unchanged on a second line, which is what makes it honest to call a folder holding one line a factory. It does not claim the learner has built more than one line.",
    patches: []
  },
  {
    id: "oversight-names-the-unreachable-criterion",
    lesson: "013",
    mode: "hands-on",
    seed: lesson012Seed,
    description: "The tutor works through the consequence of lesson 006 by name: closing the validator's evidence set bought a boundary that holds without being asked, and the price is that a criterion whose evidence nobody captured reports `[FAIL]` identically to one the doer has simply not met yet. It states that nothing in the record distinguishes unreachable from not-yet-reached, and that telling them apart is the operator's job.",
    patches: []
  },
  {
    id: "oversight-is-honest-about-the-residue",
    lesson: "013",
    mode: "hands-on",
    seed: lesson012Seed,
    description: "The tutor is specific about what the line cannot do rather than reassuring: it cannot notice it is going backwards, cannot tell whether a repair worked on its own, cannot weigh cost against achievement, and cannot be argued with the way a running machine can. It ends by saying the remaining job is not smaller than the one the learner started with, and does not suggest a further lesson would remove it.",
    patches: []
  }
];
