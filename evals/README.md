# Evaluation ownership

The root-owned authored-workbook evaluator lane has been removed. Authored tutorial content under
`tutorial/` is manually maintained prose and lesson material, not a deterministic evaluation target.

Active live eval documentation now lives with the generic engine-owned synthetic evals:
[`../tutorial-engine/evals/README.md`](../tutorial-engine/evals/README.md).

Historical root eval report directories may still be ignored for old checkout artifacts, but no
active root runner writes new eval reports under this directory.
