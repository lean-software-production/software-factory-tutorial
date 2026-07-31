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
    factory-stubs.ts
  scenarios/
    lesson-001/
      agent-led-happy-path.ts
      learner-led-happy-path.ts
      learner-mistakes/
    lesson-002/
      learner-mistakes/
  judge-calibration/
  reports/                 # ignored
```

Add `npm run eval` at the root. With no scope it prints help and an estimated budget; a run requires `--scenario`, `--lesson`, or `--all`. The harness starts the trusted checked-out engine against a disposable workspace, consumes its SSE event stream, and posts browser messages through shared protocol helpers. It therefore tests the engine’s server, event protocol, tutor adapter, and real tutoring behavior without browser automation.

Do not place these evals inside `tutorial-engine/`: lesson fixtures, artifacts, and acceptance criteria belong to the repository-level tutorial.

## Alternatives considered

1. Drive `PiTutorialAdapter` directly. This is faster but bypasses the HTTP and SSE boundary, so it is appropriate for unit tests rather than these evals.
2. Drive the running server through HTTP and SSE. This is the chosen design. It tests the real tutor and browser protocol at a practical cost.
3. Drive the browser with Playwright. This adds rendering coverage but makes live model evals slower and more fragile. Add a small separate browser smoke test later if needed.

## Workspace lifecycle

Each scenario creates a clean temporary copy of the checked-out repository. The copy excludes `.git`, `node_modules`, secrets, and old eval reports. The trusted engine code and installed dependencies remain in the checkout; the temporary copy is passed as its explicit workspace. The runner uses an ephemeral port, waits for the SSE snapshot as its readiness probe, and closes the server in `finally`. It terminates child processes on abnormal exit, preserves failed workspaces and logs, and removes successful workspaces.

The engine must enforce its workspace boundary rather than relying on a prompt. Its read, edit, write, grep, find, and ls tools resolve paths through a workspace-only layer that rejects escapes after resolving symlinks. Each call emits a sanitized audit event containing its tool name, workspace-relative paths, mutation flag, and outcome. The evaluator uses those events as evidence; the production engine gets the same protection. The runner also starts with a scrubbed environment. This is a tool-level boundary, not a claim of a full operating-system sandbox.

The harness never runs `factory/factory.sh` against a real Pi worker. It runs `bash -n`, then executes the script on a controlled `PATH` with deterministic `pi` and `npm` stubs. The stubs record arguments, working directory, prompt input, test outcomes, and pause behavior. They simulate success and failure sequences, so the eval can prove loop, branch, pipe, tool-allowlist, working-directory, and recovery behavior without a second model call.

## Browser contract

Move the browser-message schema, event types, and message serialization into a shared protocol module consumed by the server, web client, and eval driver. The UI must not maintain its own copy of those types. Add a small, deterministic browser smoke test that opens the local UI, receives an initial event, selects one choice, and observes the resulting request. It is separate from paid live evals.

## Personas and driver protocol

The learner is a deterministic scenario driver, never a second model. A scenario declares a sequence of structured checkpoints, fixed learner messages, and canonical atomic patches. A checkpoint is an observed protocol event or audit event, not a phrase inferred from streamed prose. Each patch has a precondition, a target path, an expected resulting state, and the tutor message that preceded it. The judge receives that message and patch pair to assess whether the instruction was actionable.

The driver waits for a `choice` event, maps the required option label to that event’s option ID, and posts the ID. It does not assume IDs persist across sessions or parse an assistant message to find a choice. When a checkpoint is reached, it applies the scenario patch, snapshots the workspace, and sends its fixed completion or feedback message. If the tutor emits an unsupported choice or never reaches the checkpoint, the run ends as a non-retryable persona-protocol deviation with its partial trace preserved.

### Delegating learner

This learner selects “Make it for me” whenever the scenario expects delegation. They expect short explanations, explicit control before edits, and a working result. The tutor must not make unrelated changes.

### Hands-on learner

This learner selects “I’ll do it,” requests exact typing guidance at its declared checkpoint, applies the corresponding canonical patch, and reports completion. The tutor must first give a short conceptual outline, teach in the active specification’s stated implementation order, keep edits small, and inspect work when asked for feedback.

### Hands-on learner with a mistake

This learner follows the same deterministic path but applies a canonical defective patch at one named checkpoint, then asks for feedback. The tutor must inspect the relevant artifact, identify the actual defect and its consequence, then propose the smallest correction without taking control unless asked.

## Initial scenario matrix

Start with six lesson-001 sessions:

| Scenario | Persona action | Required evidence |
| --- | --- | --- |
| `agent-led-happy-path` | Always delegates | The tutor offers control before editing and creates only the required factory files. The completed artifact implements the specified loop. |
| `learner-led-happy-path` | Works through the lesson and asks once for exact typing guidance | The tutor gives an outline, teaches in the active specification’s stated implementation order, gives small instructions, and checks reported work. For lesson 001, it starts with the Bash loop. |
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

The gate checks only observable facts:

- the server produces an SSE snapshot, accepts valid shared-protocol messages, and ends without a protocol error or timeout;
- an initial `choice` event occurs before any audited mutation;
- every learner choice resolves the option ID selected by the scenario;
- a relevant audited read precedes a tutor mutation made after a learner feedback request;
- hands-on workspace changes come from the scenario patch unless the learner explicitly delegated that step;
- every audited path is workspace-relative and accepted by the workspace boundary;
- snapshots prove the injected defect existed when feedback was sent and was repaired only after the correction checkpoint; and
- artifact and stubbed-runtime checks prove the required files, exact Pi invocation, tool allowlist, calculator working directory, loop, pause, and—where applicable—test-failure routing.

Assertions about whether a diagram was understandable, a defect was explained, or guidance followed the active specification’s implementation order belong to the judge.

### LLM judge

A separate stateless judge receives the scenario brief, active spec, event/transcript log, cited audit events, relevant diffs, deterministic results, canonical patch/message pairs, and expected mistake. It must return structured JSON with event IDs that the harness verifies exist.

Each applicable dimension receives 0–2 with these anchors:

| Dimension | 0 | 1 | 2 |
| --- | --- | --- | --- |
| Persona respect and agency | Takes control or ignores the chosen path | Mostly respects the path but overreaches or leaves control unclear | Honors each choice and preserves the learner’s role |
| Accuracy against the lesson | Contradicts or misses a material requirement | Correct but incomplete or imprecise | Follows the active specification’s implementation order and correctly connects the step to the lesson’s key constraint |
| Step size and clarity | Vague or overwhelms with a finished solution | Actionable but broader than needed or weakly explained | Gives the smallest actionable step and explains its purpose |
| Mistake diagnosis (mistake scenarios only) | Misses or misidentifies the defect | Names the defect without its consequence | Identifies the defect, its consequence, and why the correction matters |
| Correction or completion guidance | No usable next step | Usable but unnecessarily broad | Gives the smallest useful next action consistent with the learner’s choice |

Mistake diagnosis is not applicable to happy paths and is excluded from their denominator. A single run passes when every applicable dimension is above 0 and its applicable score is at least 80 percent (7/8 for happy paths; 8/10 for mistake paths), in addition to the deterministic gate.

`evals/judge-calibration/` contains versioned, hand-reviewed good and bad transcript packets. Judge prompt or model changes must score those packets as expected before they can gate regressions. The default run uses one judge call. `--repeat 3` makes three fresh tutor workspaces and judge calls; a scenario is a stable pass only when at least two runs pass and the median applicable percentage is at least 80. Judge model selection is explicit through environment configuration such as `EVAL_JUDGE_MODEL`; the tutor keeps the normal tutorial configuration.

## Commands and reports

The entry point requires an explicit scope:

```sh
npm run eval -- --scenario learner-led-happy-path
npm run eval -- --lesson 002
npm run eval -- --all
npm run eval -- --scenario learner-led-happy-path --repeat 3
```

Before starting, it prints the selected scenarios, tutor and judge models, and a token budget. The initial suite has six tutor sessions and six judge calls; budget roughly 120,000 total model tokens and 10–30 minutes when run sequentially. Actual cost depends on the configured providers, so the command warns before `--all` and supports an explicit non-interactive confirmation flag.

Write ignored artifacts to `evals/reports/<run-id>/`:

- Git revision, Node version, tutor model/configuration, judge model, scenario and calibration versions, timestamps, durations, and retry classification;
- raw SSE events, audited tool records, and posted browser messages;
- a readable tutor transcript, workspace snapshots, and diff;
- deterministic assertion and stub-runtime results;
- judge JSON with verified citations; and
- a concise Markdown summary.

A retry uses a fresh workspace and is allowed only for infrastructure failures: provider 429/5xx responses, connection reset, or a timeout before the first model output. A tutor timeout after output, a protocol error, a bad artifact, a persona-protocol deviation, or a poor judge result is never retryable. A successful retry is reported as a pass after infrastructure retry, not a clean first-pass result. The eval README documents setup, budget, scenario authoring, score interpretation, and regression review.
