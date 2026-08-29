# Authored workbook evaluator

Root-owned evaluator code for the authored learner workbook lives here. It is separate from the synthetic tutorial-engine mechanics evals under `tutorial-engine/evals/`.

`command-stubs.ts` provides deterministic Pi/npm command stubs for post-Lesson-001 authored scenarios. The stubs are designed for later authored scenario-runner integration. They materialize generated bin/state/evidence under the disposable session workspace's ignored `factory/.tmp/authored-eval-command-stubs/`, which will be visible as `/workspace/factory/.tmp/authored-eval-command-stubs/` through the canonical Docker bind mount.

The later Docker runner must prepend the mounted bin path and separately enforce terminal network policy. Evidence and config inside the learner mount are untrusted corroborating gate inputs: later gates must cross-check them against the workspace and public JSON/RPC traces, never treat them as sole authority.

`public-trace.ts` rebuilds the judge-visible trace from learner-visible state, terminal transcript, reflection turns, editor status, projected progression events, and explicitly allowlisted artifacts. Keep raw timeline rows, command/evidence IDs, Tutor or Coach prompt text, credentials, and disposable paths out of public prompts and reports.

`judge.ts` and `reports.ts` provide the privacy-safe judge prompt, result validation, verdict rule, and per-run report bundle. Scenario code must pass a rebuilt public descriptor with only `id`, `title`, `description`, and unique public criteria. Successful runs write curated artifacts under ignored `evals/workbook/reports/<run-id>/`: `trace.json`, `judge-input.txt`, `judge.json`, `report.json`, `summary.md`, and `metadata.json`. Local diagnostics such as `gate.json`, `failure.txt`, and `cleanup-failure.txt` may contain private details and must not be published or embedded in curated report files.
