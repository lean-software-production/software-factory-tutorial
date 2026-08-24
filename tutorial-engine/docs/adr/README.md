# Tutorial engine Architecture Decision Records

This directory records durable architecture decisions about the tutorial engine. It does not govern the
tutorial curriculum, lesson specifications, or general repository administration.

## Working with ADRs

Run ADRgen from `tutorial-engine/`:

```sh
adrgen create "Decision title"
adrgen status <number> accepted
adrgen create "Replacement decision" --supersedes <number>
adrgen list
```

Use ADRs for decisions that shape the engine’s architecture. State the context, the decision, and its
consequences. Do not rewrite an accepted decision; create a superseding ADR when the decision changes.
Update the index below whenever you create a record or change its status.

## Index

| ADR | Status | Title |
| --- | --- | --- |
| [0001](0001-use-architecture-decision-records.md) | accepted | Use Architecture Decision Records |
| [0002](0002-model-evaluated-learner-work-as-attempts.md) | accepted | Model evaluated learner work as attempts |
| [0003](0003-use-one-long-running-workbook-tutor-session.md) | superseded | Use one long-running workbook tutor session |
| [0004](0004-use-the-workbook-event-log-as-canonical-tutor-history.md) | superseded | Use the workbook event log as canonical tutor history |
| [0005](0005-use-a-main-tutor-with-on-demand-block-tutors.md) | accepted | Use a main tutor with on-demand block tutors |
| [0006](0006-project-workbook-tutor-history-by-role-and-compaction-scope.md) | accepted | Project workbook tutor history by role and compaction scope |
| [0007](0007-model-every-progression-unit-as-a-workbook-block.md) | accepted | Model every progression unit as a workbook block |
