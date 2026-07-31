# Live tutorial evals design

## Purpose

Evaluate the tutorial as a learner experiences it, while exercising the tutorial engine’s server and browser protocol. Each eval runs a real model-led tutoring session in an isolated copy of the tutorial. It measures both whether the tutorial reaches a correct artifact and whether the tutor teaches, diagnoses mistakes, and preserves learner control.

Live evals are an explicit, paid developer command. They do not run as part of `npm test` or `npm run check`.

## Placement

Keep the suite at the repository root because it evaluates both the tutorial content and the engine:

```text
evals/
  README.md
  run.ts
  harness/
    session.ts
    workspace.ts
    assertions.ts
    judge.ts
  scenarios/
    agent-led-happy-path.ts
    learner-led-happy-path.ts
    learner-mistakes/
  reports/                 # ignored
```

Add `npm run eval` at the root. The harness starts the real local server against a disposable workspace, consumes its SSE event stream, and posts the same HTTP browser messages that the web client sends. It therefore tests the engine’s server, event protocol, tutor adapter, and real tutoring behavior without browser automation.

Do not place these evals inside `tutorial-engine/`: lesson fixtures, artifacts, and acceptance criteria belong to the repository-level tutorial.

## Alternatives considered

1. Drive `PiTutorialAdapter` directly. This is faster but bypasses the HTTP and SSE boundary, so it is appropriate for unit tests rather than these evals.
2. Drive the running server through HTTP and SSE. This is the chosen design. It tests the real tutor and browser protocol at a practical cost.
3. Drive the browser with Playwright. This adds rendering coverage but makes live model evals slower and more fragile. Add a small separate browser smoke test later if needed.

## Workspace lifecycle

Each scenario creates a clean temporary copy of the checked-out repository. The copy excludes `.git`, `node_modules`, secrets, and old eval reports. The harness starts a server against that copy, drives a complete learner journey, captures evidence, then removes a successful workspace. It preserves a failed workspace and reports its path for diagnosis.

The harness never runs `factory/factory.sh`, because that would start a second live agent and make an eval nondeterministic. It validates generated scripts with `bash -n` and scenario-specific semantic checks instead.

## Personas

### Delegating learner

This learner always selects “Make it for me.” They expect short explanations, explicit control before edits, and a working result. The tutor must not make unrelated changes.

### Hands-on learner

This learner selects “I’ll do it,” requests exact typing guidance once, applies each small edit, and reports completion. The tutor must first give a short conceptual outline, teach from the visible heart of the change outward, keep edits small, and inspect work when asked for feedback.

### Hands-on learner with a mistake

This learner follows the hands-on path but injects one realistic, localized mistake at a teaching checkpoint. They ask for feedback. The tutor must inspect the relevant artifact, identify the actual defect and its consequence, then propose the smallest correction without taking control unless asked.

Scenario drivers select options by their live labels rather than hard-coded choice IDs. They wait for semantic checkpoints such as the initial choice, learner-led follow-up, feedback request, or relevant inspection. This tolerates ordinary variation in model phrasing and tool-call order.

## Initial scenario matrix

Start with six lesson-001 sessions:

| Scenario | Persona action | Required evidence |
| --- | --- | --- |
| `agent-led-happy-path` | Always delegates | The tutor offers control before editing and creates only the required factory files. The completed artifact implements the specified loop. |
| `learner-led-happy-path` | Works through the lesson and asks once for exact typing guidance | The tutor gives an outline, teaches from the heart outward, gives small instructions, and checks reported work. |
| `mistake-missing-tools` | Omits Pi’s `--tools` allowlist | The tutor identifies the lost isolation boundary and gives the smallest repair. |
| `mistake-wrong-calculator-directory` | Runs Pi outside `calculator/` | The tutor identifies the scope error and explains why the worker must be limited to the kata. |
| `mistake-invalid-prompt-boundary` | Allows the worker to run tests or shell commands in `refactor.md` | The tutor identifies the lack of independent validation rather than only correcting wording. |
| `mistake-no-enter-pause` | Omits the Enter pause | The tutor notices the missing learner control point and supplies a minimal correction. |

Add the first lesson-002 session once lesson-002 execution is enabled:

| Scenario | Persona action | Required evidence |
| --- | --- | --- |
| `mistake-inverted-recovery-branch` | Reverses the `test-failure.log` condition | The tutor explains the evidence flow: a failure selects healing; no failure selects normal refactoring. It then suggests the minimal branch correction. |

Lesson-002 semantic checks will also cover independent `npm test`, failure-log creation/removal, prompt selection, and recovery-branch orientation.

## Evaluation results

Every run has two independent results.

### Deterministic gate

The harness checks that:

- the real server completes the HTTP/SSE journey without a protocol error or timeout;
- orientation presents the active lesson’s flow and offers a learner choice before an edit;
- the selected persona path is respected;
- learner-led feedback inspects the relevant file before accepting work or proposing a correction;
- the tutor does not edit hands-on work without an explicit delegation choice;
- the expected files and lesson semantics exist at completion, including the exact Pi invocation, tool restriction, calculator working directory, loop, and pause;
- an injected mistake is detected before it is repaired; and
- the tutor does not access outside the isolated workspace.

### LLM judge

A separate stateless judge receives the scenario brief, active spec, event/transcript log, relevant diffs, deterministic results, and expected mistake. It returns structured JSON containing brief evidence citations and a 0–2 score for each dimension:

1. Persona respect and learner agency.
2. Accuracy against the active lesson.
3. Step size and clarity.
4. Mistake diagnosis and explanation, where applicable.
5. Smallest useful correction or completion guidance.

A run passes only when deterministic checks pass, no dimension receives 0, and the total is at least 8/10. Judge model selection is explicit through environment configuration such as `EVAL_JUDGE_MODEL`; the tutor keeps the normal tutorial configuration.

## Commands and reports

The entry point supports focused and repeated runs:

```sh
npm run eval
npm run eval -- --scenario learner-led-happy-path
npm run eval -- --lesson 002
npm run eval -- --repeat 3
```

Write ignored artifacts to `evals/reports/<run-id>/`:

- Git revision, Node version, tutor model/configuration, judge model, scenario version, timestamps, and durations;
- raw SSE events and posted browser messages;
- a readable tutor transcript and workspace diff;
- deterministic assertion results;
- judge JSON; and
- a concise Markdown summary.

Use bounded phase timeouts and one recorded retry for transient provider failures. A retry is visible in the report; it is not treated as a clean first-pass result. The eval README documents setup, estimated cost and duration, scenario authoring, score interpretation, and regression review.
