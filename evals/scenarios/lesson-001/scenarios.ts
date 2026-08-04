export type LearnerMode = "delegate" | "hands-on" | "mistake";

export interface FileExpectation {
  exists?: boolean;
  contains?: RegExp[];
  excludes?: RegExp[];
}

/** Expectations are file-specific so a defect cannot accidentally match a healthy sibling file. */
export type ArtifactState = Record<string, FileExpectation>;

export interface CanonicalPatch {
  name: string;
  /** The only files the deterministic learner changes in this atomic step. */
  files: Record<string, string>;
  message: string;
  /** State that must exist immediately before the learner makes this edit. */
  preconditions: ArtifactState;
  /** State captured immediately after this edit, before any later repair. */
  expectedState: ArtifactState;
  checkpoint: "guided-step" | "correction";
}

export interface Scenario {
  id: string;
  lesson: "001" | "002" | "003" | "004" | "005" | "006";
  mode: LearnerMode;
  description: string;
  expectedMistake?: string;
  /** Ordered, small learner edits. `defect` and `repair` retain stable report names. */
  patches: CanonicalPatch[];
  /** Final file-specific artifact expectations for deterministic offline gates. */
  finalState?: ArtifactState;
}

/**
 * Lesson 001 runs one headless Pi command by hand and creates no file, so these
 * scenarios carry no patches and no `finalState`. Nothing deterministic is left
 * on disk to grade: the model-graded judge reads the transcript against
 * `docs/specs/001-run-an-agent-headlessly.md`, so each description names what
 * the tutor must have done and each `expectedMistake` names the specific,
 * observable way the transcript can fail.
 */
export const scenarios: Scenario[] = [
  {
    id: "headless-run-happy-path",
    lesson: "001",
    mode: "hands-on",
    description: "The tutor walks the learner through the specification's three runs in order — the headless command, the same command without `-p`, and the command with a job of the learner's own — and only then asks the checks. The learner is left able to say, in their own words, which part of the command was the harness and which was the job to be done, what `-p` changed, and what this agent could not have done however it was asked.",
    patches: []
  },
  {
    id: "headless-run-explains-the-flag-without-borrowing-later-vocabulary",
    lesson: "001",
    mode: "hands-on",
    description: "The learner asks what `-p` does, and the tutor answers with what this lesson has established: Pi does the job and exits, with no human in its conversation. It names the agent, the harness, the job to be done, and the boundary, and it stops there.",
    expectedMistake: "The tutor reached for vocabulary the learner has not built yet — doer, validator, machine, assembly line, factory, orchestrator, or a diagram of a loop — to explain a single headless command.",
    patches: []
  },
  {
    id: "headless-run-refuses-to-build-a-file",
    lesson: "001",
    mode: "hands-on",
    description: "The learner offers to write the command into a script or a prompt file, and the tutor declines, holds the lesson to running commands by hand, and says why the first agent is worth meeting before anything wraps it.",
    expectedMistake: "The tutor let lesson 001 create an artefact, so the learner started building before they had run one agent and read what came back.",
    patches: []
  }
];
