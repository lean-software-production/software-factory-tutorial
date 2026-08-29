# Authored workbook evaluator

Root-owned evaluator code for the authored learner workbook lives here. It is separate from the synthetic tutorial-engine mechanics evals under `tutorial-engine/evals/`.

`command-stubs.ts` provides deterministic Pi/npm command stubs for post-Lesson-001 authored scenarios. The stubs are designed for later authored scenario-runner integration. They materialize generated bin/state/evidence under the disposable session workspace's ignored `factory/.tmp/authored-eval-command-stubs/`, which will be visible as `/workspace/factory/.tmp/authored-eval-command-stubs/` through the canonical Docker bind mount.

The later Docker runner must prepend the mounted bin path and separately enforce terminal network policy. Evidence and config inside the learner mount are untrusted corroborating gate inputs: later gates must cross-check them against the workspace and public JSON/RPC traces, never treat them as sole authority. Future authored-workbook reports should be written under ignored `evals/workbook/reports/`, not under `tutorial-engine/evals/reports/`.
