# Evaluation ownership map

This directory is root-owned. It holds authored-workbook evaluation foundations today and the future authored-workbook live runner later. It is deliberately separate from the tutorial-engine's synthetic mechanics evals.

| Path | Owner | Scope | Markers | Reports | Commands |
| --- | --- | --- | --- | --- | --- |
| [`../tutorial-engine/evals/`](../tutorial-engine/evals/) | `tutorial-engine` | Synthetic engine-mechanics live evals and their deterministic evaluator tests. These exercise the engine, not the authored curriculum. | Engine-v2 envelopes use namespace `tutorial-engine/evals/engine-v2`, owner `tutorial-engine`, suite `engine-v2`, and `schemaVersion`. | Active live reports are ignored under `tutorial-engine/evals/reports/`. | Deterministic/model-free: `npm run --workspace=tutorial-engine check:eval` and `npm run --workspace=tutorial-engine test:eval`. Live/paid/Docker-backed: `npm run eval:engine -- ...` or `npm run --workspace=tutorial-engine eval -- ...`. |
| [`workbook/`](workbook/) | `root` | Real authored-curriculum evaluator foundations and the future authored-workbook live runner. Current fixtures seed curriculum slices; they are not synthetic engine scenarios. | Current fixture manifest uses schema `workbook-evaluator-prerequisite-seeds/v1` and owner `evals/workbook`. Future live report envelopes should carry workbook-owned markers, not engine-v2 markers. | Future live reports belong under ignored `evals/workbook/reports/`. | Current deterministic/model-free commands are `npm run check:eval:workbook` and `npm run test:eval:workbook`. `eval:workbook` is reserved and intentionally not wired until the live runner lands. |
| `reports/` | historical root compatibility | Historical root eval report location from older runner shapes. | None for active code. | Ignored for compatibility only. No active runner writes `evals/reports/`. | None. Do not delete, migrate, or rewrite historical report artifacts or historical plan paths as part of current eval work. |

## Root aliases

- `npm run eval:engine -- ...` forwards to the tutorial-engine live evaluator.
- `npm run eval:release` forwards to the bounded six-scenario engine release profile.
- `npm run eval -- ...` is a temporary compatibility alias for `eval:engine`. It is not an authored-workbook eval.
- `eval:workbook` remains reserved. The package script is absent until the authored-workbook live runner lands.

## Deterministic versus live checks

The deterministic commands (`check:eval:workbook`, `test:eval:workbook`, and the tutorial-engine `check:eval`/`test:eval`) are model-free. They do not call the Main Tutor, Practice Coach, or Judge, and they do not require Docker.

The live engine evaluator is paid and Docker-backed. Before running it, build the workbook terminal image, keep Docker available, provide `OPENCODE_API_KEY`, configure host Pi auth and model access for the Main Tutor, Practice Coach, and Judge, and export `EVAL_JUDGE_MODEL`. See [`../tutorial-engine/evals/README.md`](../tutorial-engine/evals/README.md) for the full preflight order, release versus exploratory scopes, and report-file boundary.

The authored-workbook live runner does not exist yet. Until it lands, use [`workbook/prerequisites/README.md`](workbook/prerequisites/README.md) for the current deterministic fixture rules.

## Public reports and diagnostics

Engine live reports distinguish public curated files from local diagnostics. Public records live in files such as `trace.json`, `artifacts.json`, `judge-input.txt`, `judge.json`, `report.json`, `summary.md`, `metadata.json`, and `latest.json`. Diagnostic files such as `gate.json`, `failure.txt`, and `cleanup-failure.txt` may include internal assertion details, local paths, stack traces, or server URLs. Do not publish diagnostics blindly.

The future authored-workbook runner should keep the same public-versus-diagnostic separation under `evals/workbook/reports/` and should not reuse `tutorial-engine/evals/reports/` or the historical root `evals/reports/` location.
