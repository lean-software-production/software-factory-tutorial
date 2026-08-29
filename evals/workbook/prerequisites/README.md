# Workbook evaluator prerequisite seeds

These root-owned fixtures belong to the authored-workbook evaluator. They are disposable inputs for
future curriculum-slice or session materialisation, not claims that a learner has already completed
any lesson.

Materialise a seed by copying its contents into a fresh `refactor-line` workspace root that already
contains `calculator/`. The evaluator supplies the fixed in-workspace line path `factory/refactor`
and invokes the factory-level operator scripts with the authored line argument `refactor`. Do not
copy anything back into `tutorial/`, and do not persist regenerated `.tmp` evidence, event logs,
baselines, FIFOs, or session state in this directory.

Live execution is canonical in the Linux workbook terminal/Docker runtime. These fixtures intentionally
keep the authored shell mechanisms, including `sleep infinity` for the RPC channel holder and
line-name arguments for `watch.sh`, `ask.sh`, and `steer.sh`; do not silently improve them away from
the curriculum.

The Lesson 003 and 004 fixtures provide only the authored prerequisites needed to begin those lessons.
If Part 1 lesson files change what the learner authors, update these evaluator fixtures in the same
move as the Part 2 seed. The completed-factory Lesson 013 fixture provides the factory source that
should exist after Lesson 012 has been built, with no generated run artefacts.
