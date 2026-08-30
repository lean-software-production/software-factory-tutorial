# Evaluation ownership map

This directory is root-owned. It holds authored-workbook evaluation foundations and the authored-workbook live runner. It is deliberately separate from the tutorial-engine's synthetic mechanics evals.

| Path | Owner | Scope | Markers | Reports | Commands |
| --- | --- | --- | --- | --- | --- |
| [`../tutorial-engine/evals/`](../tutorial-engine/evals/) | `tutorial-engine` | Synthetic engine-mechanics live evals and their deterministic evaluator tests. These exercise the engine, not the authored curriculum. | Engine-v2 envelopes use namespace `tutorial-engine/evals/engine-v2`, owner `tutorial-engine`, suite `engine-v2`, and `schemaVersion`. | Active live reports are ignored under `tutorial-engine/evals/reports/`. | Deterministic/model-free: `npm run --workspace=tutorial-engine check:eval` and `npm run --workspace=tutorial-engine test:eval`. Live/paid/Docker-backed: `npm run eval:engine -- ...` or `npm run --workspace=tutorial-engine eval -- ...`. |
| [`workbook/`](workbook/) | `root` | Real authored-curriculum evaluator foundations and live runner. Current fixtures seed curriculum slices; they are not synthetic engine scenarios. | Report envelopes carry namespace `root/workbook`, owner `root`, suite `workbook`, and `schemaVersion`. | Live reports belong under ignored `evals/workbook/reports/`. | Deterministic/model-free: `npm run check:eval:workbook` and `npm run test:eval:workbook`. Live/paid/Docker-backed: `npm run eval:workbook -- ...`. |
| `reports/` | historical root compatibility | Historical root eval report location from older runner shapes. | None for active code. | Ignored for compatibility only. No active runner writes `evals/reports/`. | None. Do not delete, migrate, or rewrite historical report artifacts or historical plan paths as part of current eval work. |

## Root aliases

- `npm run eval:engine -- ...` forwards to the tutorial-engine live evaluator.
- `npm run eval:release` forwards to the bounded six-scenario engine release profile.
- `npm run eval -- ...` is a temporary compatibility alias for `eval:engine`. It is not an authored-workbook eval.
- `npm run eval:workbook -- ...` runs the authored-workbook live evaluator; `--release` runs the four-scenario catalog once.

## Deterministic versus live checks

The deterministic commands (`check:eval:workbook`, `test:eval:workbook`, and the tutorial-engine `check:eval`/`test:eval`) are model-free. They do not call the Main Tutor or Judge, and they do not require Docker.

The live engine evaluator is paid and Docker-backed. Before running it, build the workbook terminal image, keep Docker available, provide `OPENCODE_API_KEY`, configure host Pi auth and model access for the Main Tutor and Judge, and export `EVAL_JUDGE_MODEL`. See [`../tutorial-engine/evals/README.md`](../tutorial-engine/evals/README.md) for the full preflight order, release versus exploratory scopes, and report-file boundary.

The authored-workbook live runner is paid and Docker-backed. Use `--list` for a zero-side-effect catalog listing. Live scopes accept `--scenario <exact-id>`, `--all --yes`, or `--release`, plus the same preflight model and budget flags documented in [`workbook/README.md`](workbook/README.md). Do not run it unless you intend to spend Main Tutor and Judge tokens.

## Public reports and diagnostics

Engine live reports distinguish public curated files from local diagnostics. Public records live in files such as `trace.json`, `artifacts.json`, `judge-input.txt`, `judge.json`, `report.json`, `summary.md`, `metadata.json`, and `latest.json`. Diagnostic files such as `gate.json`, `failure.txt`, and `cleanup-failure.txt` may include internal assertion details, local paths, stack traces, or server URLs. Do not publish diagnostics blindly.

The authored-workbook runner keeps the same public-versus-diagnostic separation under `evals/workbook/reports/` and does not reuse `tutorial-engine/evals/reports/` or the historical root `evals/reports/` location.
