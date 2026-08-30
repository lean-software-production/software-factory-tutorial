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
| [0005](0005-use-a-main-tutor-with-on-demand-block-tutors.md) | superseded | Use a main tutor with on-demand block tutors |
| [0006](0006-project-workbook-tutor-history-by-role-and-compaction-scope.md) | accepted | Project workbook tutor history by role and compaction scope |
| [0007](0007-model-every-progression-unit-as-a-workbook-block.md) | accepted | Model every progression unit as a workbook block |
| [0008](0008-separate-work-acceptance-from-block-completion.md) | accepted | Separate work acceptance from block completion |
| [0009](0009-separate-authored-content-from-session-local-learner-state.md) | accepted | Separate authored content from session-local learner state |
| [0010](0010-use-the-workbook-tutor-as-the-only-tutorial-interface.md) | accepted | Use the workbook tutor as the only tutorial interface |
| [0011](0011-use-a-terminal-practice-coach-with-main-tutor-authority.md) | superseded | Use a terminal Practice Coach with Main Tutor authority |
| [0012](0012-render-the-workbook-from-server-state-alone.md) | accepted | Render the workbook from server state alone |
| [0013](0013-share-one-browser-safe-contract-for-terminal-socket-frames.md) | accepted | Share one browser-safe contract for terminal socket frames |
| [0014](0014-address-the-workbook-server-relatively.md) | accepted | Address the workbook server relatively |
| [0015](0015-model-behaviour-with-eventstorming.md) | accepted | Model behaviour with EventStorming |
| [0016](0016-model-terminal-coaching-around-submitted-commands.md) | superseded | Model terminal coaching around submitted commands |
| [0017](0017-simplify-terminal-learner-feedback.md) | superseded | Simplify terminal learner feedback |
| [0018](0018-use-bash-authoritative-terminal-display-states.md) | superseded | Use Bash-authoritative terminal display states |
| [0019](0019-keep-live-terminal-context-private.md) | superseded | Keep Live Terminal Context Private |
| [0020](0020-bound-terminal-assessment-retries-with-recoverable-feedback.md) | superseded | Bound terminal assessment retries with recoverable feedback |
| [0021](0021-preflight-model-backed-roles-before-workbook-startup.md) | superseded | Preflight model-backed roles before workbook startup |
| [0022](0022-use-one-shot-terminal-workflow-assessment.md) | superseded | Use one-shot terminal workflow assessment |
| [0023](0023-scope-lesson-work-to-optional-shared-session-folders.md) | superseded | Scope lesson work to optional shared-session folders |
| [0024](0024-isolate-lesson-workspaces-as-live-repositories.md) | accepted | Isolate lesson workspaces as live repositories |
| [0026](0026-use-one-stateless-main-tutor-for-practice-review.md) | accepted | Use one stateless Main Tutor for practice review |
