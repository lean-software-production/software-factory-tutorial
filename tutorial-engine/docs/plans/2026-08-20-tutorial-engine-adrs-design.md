# Tutorial-engine architecture decision records

## Purpose

The tutorial engine needs a durable record of decisions that shape its architecture. ADRs will capture
those decisions, their context, and their consequences. They do not govern the tutorial curriculum,
lesson specifications, or general repository administration.

## Location and tooling

Run ADRgen from `tutorial-engine/`:

```sh
adrgen init docs/adr
```

This creates `tutorial-engine/adrgen.config.yml` and
`tutorial-engine/docs/adr/adr_template.md`. Keeping the configuration beside the engine prevents an
engine-only convention from applying to the repository root or the tutorial curriculum.

## ADR workflow

- Create records from `tutorial-engine/` with `adrgen create "Decision title"`.
- Edit the generated record to state its context, decision, and consequences.
- Accept a settled decision with `adrgen status <number> accepted`.
- Create a superseding record when a decision changes; do not rewrite an accepted historical decision.
- Update the index in `tutorial-engine/docs/adr/README.md` whenever a record is created or its status
  changes.

## Documentation

`tutorial-engine/docs/adr/README.md` will explain the workflow and provide a Markdown index of the
engine ADRs. Its first entry will link to ADR 0001.

The repository-root `AGENTS.md` will state that architectural decisions about the tutorial engine use
this ADR directory. It will explicitly limit the convention to the engine.

## Initial record

ADR 0001 will be generated with ADRgen and titled “Use Architecture Decision Records.” It will record
that the tutorial engine uses ADRs for durable architecture decisions, explain the need for preserved
decision context, and note the maintenance cost of keeping records and their index current. The record
will be accepted.

## Verification

Run `adrgen list` from `tutorial-engine/` to verify that ADRgen finds the configuration and lists ADR
0001. Run `npm run check` from `tutorial-engine/` to confirm that the documentation-only change has not
affected the engine’s TypeScript checks or tests.
