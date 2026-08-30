# Main Tutor direct terminal review play-test

Date: 2026-08-30  
Branch/worktree: `feature/unify-practice-main-tutor` at `17591ef` before this note  
Host: macOS/darwin, Node `v24.14.1`, npm `11.11.0`  
Container: OrbStack Docker host `unix:///Users/matt/.orbstack/run/docker.sock`, Docker server `29.4.0`, canonical devcontainer Node `v24.19.0`, npm `11.19.0`  
Main Tutor model: `openai-codex/gpt-5.6-luna` (`TUTOR_MODEL`)  
Doer model reported by setup: `openai-codex/gpt-5.6-sol`  
Eval judge used for the successful judge-auth diagnosis run: `openai-codex/gpt-5.6-terra`

This note records Task 7 evidence only. I did not implement fast routing, did not create a follow-up Yak, and did not publish private command evidence, transcripts, workspace file contents, or rubrics.

## Methodology

- Ran every verification command from the Task 7 brief and recorded exit status plus the material output below. Full command logs are in ignored SDD scratch space.
- Used the canonical devcontainer through OrbStack for visual validation: `DOCKER_HOST=unix:///Users/matt/.orbstack/run/docker.sock`.
- Ran ten live programmatic terminal-review play-tests through `createWorkbookWorkflow()` + `DefaultMainWorkbookTutor`, with synthetic anonymized terminal evidence and active workspace roots. The workflow logger's production terminal telemetry supplied `durationMs`, `finishedToDecisionMs`, retry count, and outcome. Workload labels below are anonymous; raw commands, transcripts, workspace file contents, and private guidance are intentionally omitted.
- Replayed/continued the legacy session only after copying it from the primary checkout into this worktree's ignored `tutorial/.tutorial/` area. The original session was not modified.
- Inspected the approved visual state-gallery images for desktop and 390px narrow editor/terminal feedback bars after the canonical visual command passed.

## Automated gates

| Gate | Exact command | Result |
| --- | --- | --- |
| Setup/model identity | `TUTOR_MODEL=openai-codex/gpt-5.6-luna EVAL_JUDGE_MODEL=gpt-5.6-terra npm run setup` | Passed. Pi authenticated. Main tutor `openai-codex/gpt-5.6-luna`; doer `openai-codex/gpt-5.6-sol`. |
| Docker engine | `DOCKER_HOST=unix:///Users/matt/.orbstack/run/docker.sock docker context show` and `DOCKER_HOST=unix:///Users/matt/.orbstack/run/docker.sock docker info --format 'ServerVersion={{.ServerVersion}} OperatingSystem={{.OperatingSystem}} OSType={{.OSType}} Architecture={{.Architecture}}'` | Passed. Context `default`; `ServerVersion=29.4.0 OperatingSystem=OrbStack OSType=linux Architecture=aarch64`. |
| Engine check | `npm run --workspace=tutorial-engine check` | Passed. Lint, TypeScript, eval typecheck, Vitest `53` files / `510` tests, workbook web build, and browser smoke passed. |
| Workbook static check | `npm run --workspace=tutorial-engine check:workbook` | Passed. `Software Factory Tutorial: 15 lesson(s), 3 part(s).` |
| Onboarding | `npm run test:onboarding` | Passed. Node test runner: `17` tests passed, `0` failed. |
| Learner calculator | `npm run --workspace=tutorial/workspaces/refactor-line/calculator test` | Passed. Build plus Vitest: `1` file / `9` tests passed. |
| Deterministic workbook factory | `npm run --workspace=tutorial-engine factory:workbook:deterministic` | First run failed with the known step-33 adjacent-frame teleport analyzer flake. Rerun with no code changes passed and wrote the normal factory report/result artifacts. |
| Eval, exact brief command | `TUTOR_MODEL=openai-codex/gpt-5.6-luna EVAL_JUDGE_MODEL=gpt-5.6-terra npm run eval` | Failed before running scenarios: eval now requires an explicit scope and printed usage. |
| Eval, all scenarios with configured tutor and provider-qualified judge | `TUTOR_MODEL=openai-codex/gpt-5.6-luna EVAL_JUDGE_MODEL=openai-codex/gpt-5.6-terra npm run eval -- --all --yes` | Ran live. `5/6` scenarios passed; `v2-editor-feedback-locked` failed its deterministic gate because no public editor feedback state was recorded. Rerunning that scenario alone reproduced the failure. |
| Devcontainer startup | `DOCKER_HOST=unix:///Users/matt/.orbstack/run/docker.sock devcontainer up --workspace-folder .` | Passed. Reused container `2ee0ce150ff574b431c90fb896833a9ccdb9eef8555dd108e0180459ec2c2878`, remote workspace `/workspaces/unify-practice-main-tutor`. |
| Canonical visual | `DOCKER_HOST=unix:///Users/matt/.orbstack/run/docker.sock devcontainer exec --workspace-folder . bash -lc 'pwd && node --version && npm --version && npm run --workspace=tutorial-engine test:visual'` | Passed in `/workspaces/unify-practice-main-tutor` with Node `v24.19.0`, npm `11.19.0`. Final line: `Visual affordance validation passed: reading-line promotion, activity band expansion, composer auto-resize, practice feedback bar states.` |
| Root check | `DOCKER_HOST=unix:///Users/matt/.orbstack/run/docker.sock npm run check` | First run timed out after 1800s during the root orchestration. Rerun with a longer command timeout passed: onboarding, engine check, workbook check, calculator tests, and canonical visual check all completed successfully. |

## Live direct terminal-review benchmark

Durations are milliseconds. `direct review` is the summed model-review call duration for the run; `command→decision` is the production workflow's command-finished-to-final-decision telemetry. Nearest-rank p95 for ten samples is the maximum value.

| # | Workload label | Expected | Outcome | Direct review ms | Command→decision ms | Retry count | Contradiction |
| ---: | --- | --- | --- | ---: | ---: | ---: | --- |
| 1 | exact-success-small-output | accepted | accepted | 2962 | 2967 | 0 | no |
| 2 | wrong-command-feedback | feedback | feedback | 2756 | 2757 | 0 | no |
| 3 | nonzero-test-feedback | feedback | feedback | 2406 | 2407 | 0 | no |
| 4 | workspace-file-success | accepted | accepted | 3894 | 3897 | 0 | no |
| 5 | workspace-file-feedback | feedback | feedback | 6469 | 6470 | 0 | no |
| 6 | ralph-loop-success | accepted | accepted | 3559 | 3561 | 0 | no |
| 7 | ralph-loop-missing-pass-feedback | feedback | feedback | 3739 | 3741 | 0 | no |
| 8 | noisy-success-bounded-transcript | accepted | accepted | 2788 | 2789 | 0 | no |
| 9 | interrupted-command-feedback | feedback | feedback | 2070 | 2071 | 0 | no |
| 10 | syntax-error-feedback | feedback | feedback | 2383 | 2383 | 0 | no |

Calculations:

- Sample size: 10 live Main Tutor terminal reviews.
- Direct-review median: `2875 ms`.
- Direct-review nearest-rank p95: `6469 ms`.
- Command-finished-to-decision median: `2878 ms`.
- Command-finished-to-decision nearest-rank p95: `6470 ms`.
- Retry rate: `0/10 = 0%`.
- Outcomes: `4` accepted, `6` feedback.
- Contradictions: `0/10`.

The workspace-file pair shows the Main Tutor could use bounded terminal evidence plus active workspace state without leaking the underlying file contents into this note. The ralph/noisy/interrupted/syntax labels exercised success, material feedback, bounded transcript, and visible failure outcomes.

## Failure recovery and legacy-session replay

### Controlled current-compatible continuation from the copied legacy session

I copied the legacy play-test session to ignored worktree state, truncated it before the final `bash ralph.sh` retry, and continued from the active `run-the-factory` block with a controlled Bash-finished event. The first two terminal review calls were deliberately failed through a test wrapper around `MainWorkbookTutor.review`; this exhausted the automatic budget and exposed the terminal-local retry state. I then invoked the public retry route through `workflow.retry()`.

Result, with no private evidence published:

| Evidence | Value |
| --- | ---: |
| Final outcome | accepted |
| Retryable failure exposed before manual retry | yes |
| Direct-review duration after injected failures | 3340 ms |
| Command-finished-to-decision duration | 3468 ms |
| Retry count at decision | 2 |
| Review call outcomes | infrastructure failure, infrastructure failure, accepted |
| Command submissions for the final attempt | 1 |
| Command-finished events for the final attempt | 1 |
| Review requests for the final attempt | 3 |
| Review failures for the final attempt | 1 |
| Accepted checkpoint for the same attempt | yes |
| Work accepted for the block | yes |

This proves the saved successful command evidence can be reviewed and accepted by review-only retry without a second command submission for that attempt.

### Unmodified saved legacy evidence limitation

I also replayed the unmodified copied legacy session through the later saved `bash ralph.sh` attempt and injected the same first-review failure path. The workflow correctly preserved evidence, exposed retry, and did not add another command submission, but the live Main Tutor returned feedback rather than acceptance. The likely cause is a compatibility/content mismatch: the current block asks for visible two-pass markers, while the old saved evidence predates that wording and the now-private legacy handoff is intentionally not supplied to the Main Tutor as evidence. I did not alter runtime code for this.

## Visual inspection

Canonical visual validation passed before inspection. I inspected the approved unmasked feedback state-gallery images:

- Desktop editor: reviewing, retained-updating, actionable feedback, temporary failure, and success bars are visible, full width, and welded to the editor surface. The temporary failure state preserves the prior feedback plus amber recovery notice.
- Desktop terminal: running, checking, actionable feedback, retryable failure, and success bars are visible, full width, and welded under the terminal transcript. The old bubble triangle/floating/narrow terminal treatment is absent. The retryable failure includes a visible `Retry review` action.
- Narrow editor at 390px: all five states wrap without clipping; the bar remains aligned to the editor width.
- Narrow terminal at 390px: running/checking/actionable/failure/success bars remain aligned to the terminal width; the retry action remains reachable and the success state stays attached to the transcript.

## Recommendation

Latency alone does **not** look materially disruptive in this sample. Median command-finished-to-decision was about `2.9s`; nearest-rank p95 was about `6.5s`; no live benchmark run needed a provider retry; and there were no review contradictions. I recommend **not** opening a faster-terminal-review-model Yak solely for latency.

The concerns below are real but are quality/compatibility issues rather than evidence for fast routing.

## Limitations and concerns

- The exact `npm run eval` command in the brief no longer runs a scope-less eval; it exits with usage. With `--all --yes` and a provider-qualified judge, one live eval scenario still failed deterministically under the configured tutor model.
- The unmodified saved legacy `bash ralph.sh` evidence was not accepted by direct Main Tutor review because the current acceptance wording expects visible pass markers that the old evidence does not expose. Controlled continuation with current-compatible Bash-finished evidence did pass the retry-only recovery requirement.
- The benchmark used programmatic workflow terminal facts, not a human-driven browser terminal session. The terminal manager/Bash/UI layers were covered by the automated suite, deterministic factory, canonical visual run, and the copied-session workflow replay.
- Command runtime and learner wait time before Bash completion are intentionally excluded; this note measures only review latency after command-finished evidence exists.
