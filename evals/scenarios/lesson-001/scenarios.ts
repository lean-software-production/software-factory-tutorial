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
  /**
   * The only files the deterministic learner changes in this atomic step. A
   * `null` value deletes the file, which is what lets a lesson that moves its
   * artefacts model the move rather than only its destination.
   */
  files: Record<string, string | null>;
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
  /**
   * The defect a `mistake` scenario deliberately commits, and which the tutor
   * must diagnose. It is only meaningful in that mode: the judge prompt states
   * it as something present in the transcript, and only `mistake` scenarios
   * score the `mistakeDiagnosis` dimension. Anything a non-mistake scenario
   * must *avoid* belongs in `description`, as a requirement the judge can grade.
   */
  expectedMistake?: string;
  /**
   * What earlier lessons left in the workspace before this one begins. The
   * learner copy is created without any `factory/` files, so a lesson that
   * builds on Part 1 — or, in lesson 005's case, moves it — has to say what it
   * is building on. Applied before the session starts, by nobody the tutor sees.
   */
  seed?: Record<string, string>;
  /** Ordered, small learner edits. `defect` and `repair` retain stable report names. */
  patches: CanonicalPatch[];
  /** Final file-specific artefact expectations for deterministic offline gates. */
  finalState?: ArtifactState;
}

/**
 * Lesson 001 runs one headless Pi command by hand and creates no file, so these
 * scenarios carry no patches and no `finalState`. Nothing deterministic is left
 * on disk to grade: the model-graded judge reads the transcript against
 * `docs/specs/001-run-an-agent-headlessly.md`. None of them sets
 * `expectedMistake`: the judge prompt states that field as a defect present in
 * the transcript, so using it for something the tutor must *avoid* would reward
 * the transcript that commits it. Prohibitions are stated in `description`
 * instead, as positive requirements the judge can find or fail to find.
 */
export const scenarios: Scenario[] = [
  {
    id: "headless-run-happy-path",
    lesson: "001",
    mode: "hands-on",
    description: "The tutor walks the learner through the specification's two runs in order — the headless command, then the same command with a job of the learner's own — and only then asks the checks. The learner is left able to say, in their own words, which part of the command was the harness and which was the job to be done, what made the run headless and why that matters for what comes next, and what this agent could not have done however it was asked. The tutor never claims that dropping `-p` opens an interactive session: piping a job on standard input runs headlessly either way.",
    patches: []
  },
  {
    id: "headless-run-explains-the-flag-without-borrowing-later-vocabulary",
    lesson: "001",
    mode: "hands-on",
    description: "The learner asks what `-p` does, and the tutor answers using only what this lesson has established: it asks explicitly for a headless run, in which Pi does the job and exits with no human in its conversation. It does not claim the flag is what makes this command headless — a job piped in on standard input runs headlessly with or without it. Every term it reaches for is one of the four this lesson names — agent, harness, job to be done, boundary — and it explains the flag without introducing any Part 2 vocabulary (doer, validator, machine, assembly line, factory, orchestrator) and without drawing a loop.",
    patches: []
  },
  {
    id: "headless-run-refuses-to-build-a-file",
    lesson: "001",
    mode: "hands-on",
    description: "The learner offers to write the command into a script or a prompt file, and the tutor declines, keeps the lesson to commands run by hand, and says why meeting one agent matters before anything wraps it. The workspace still holds no file the learner created when the lesson ends.",
    patches: []
  }
];
