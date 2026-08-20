# Tutorial-engine ADRs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish a local Architecture Decision Record workflow for durable tutorial-engine architecture decisions.

**Architecture:** ADRgen configuration, template, and records live under `tutorial-engine/`, keeping this
engine-only practice separate from the tutorial curriculum. A human-maintained README indexes records
and describes the workflow; root guidance points contributors to that local convention.

**Tech Stack:** ADRgen v0.4.1-beta CLI, Markdown, YAML.

**Spec:** `docs/superpowers/specs/2026-08-20-tutorial-engine-adrs-design.md`

## Global Constraints

- Run ADRgen from `tutorial-engine/`; initialize `docs/adr` there.
- ADRs document only durable tutorial-engine architecture decisions.
- Do not apply the ADR convention to tutorial curriculum or lesson specifications.
- Maintain the README index when a record is created or its status changes.
- Keep the existing unrelated working-tree changes untouched.

---

### Task 1: Initialize tutorial-engine ADRgen workspace

**Files:**
- Create: `tutorial-engine/adrgen.config.yml`
- Create: `tutorial-engine/docs/adr/adr_template.md`

**Interfaces:**
- Consumes: `adrgen` on the devcontainer `PATH`.
- Produces: a configuration discovered by later `adrgen create`, `adrgen status`, and `adrgen list`
  commands run from `tutorial-engine/`.

- [ ] **Step 1: Confirm the target paths do not already exist**

Run:

```sh
find tutorial-engine -maxdepth 3 \( -name adrgen.config.yml -o -path 'tutorial-engine/docs/adr*' \) -print
```

Expected: no output.

- [ ] **Step 2: Initialize the engine-local workspace**

Run:

```sh
cd tutorial-engine
adrgen init docs/adr
```

Expected: `tutorial-engine/adrgen.config.yml` and
`tutorial-engine/docs/adr/adr_template.md` exist.

- [ ] **Step 3: Verify ADRgen discovers the local configuration**

Run:

```sh
cd tutorial-engine
adrgen list
```

Expected: ADRgen reports that it found the configuration and lists no ADR records.

- [ ] **Step 4: Commit the initialized workspace**

```sh
git add tutorial-engine/adrgen.config.yml tutorial-engine/docs/adr/adr_template.md
git commit -m "docs: initialize tutorial engine ADRs"
```

### Task 2: Record and document the ADR convention

**Files:**
- Create: `tutorial-engine/docs/adr/README.md`
- Create: `tutorial-engine/docs/adr/0001-use-architecture-decision-records.md`
- Modify: `AGENTS.md`

**Interfaces:**
- Consumes: the `tutorial-engine/adrgen.config.yml` created in Task 1.
- Produces: accepted ADR 0001 and instructions for maintaining engine ADRs.

- [ ] **Step 1: Generate the first ADR**

Run:

```sh
cd tutorial-engine
adrgen create "Use Architecture Decision Records"
```

Expected: ADRgen creates `docs/adr/0001-use-architecture-decision-records.md` with a `proposed`
status.

- [ ] **Step 2: Replace ADR 0001’s generated prompts with its decision**

Set `tutorial-engine/docs/adr/0001-use-architecture-decision-records.md` to:

```md
# 1. Use Architecture Decision Records

Date: 2026-08-20

## Status

accepted

## Context

The tutorial engine has architecture decisions whose rationale would otherwise be scattered across
commits, pull requests, and conversations. Contributors need one durable, local record of each decision
and its consequences.

## Decision

Use Architecture Decision Records (ADRs) for durable architecture decisions about the tutorial engine.
Store them in `tutorial-engine/docs/adr/`, create and manage them with ADRgen from `tutorial-engine/`,
and retain accepted records as history. Replace a changed decision with a superseding ADR instead of
rewriting the accepted record.

## Consequences

Contributors can find the context and consequences of an engine architecture decision in one place.
Creating, accepting, superseding, and indexing ADRs adds a small documentation task to relevant work.
```

- [ ] **Step 3: Accept ADR 0001 through ADRgen**

Run:

```sh
cd tutorial-engine
adrgen status 1 accepted
```

Expected: the command confirms the accepted status; the file still contains the content from Step 2.

- [ ] **Step 4: Write the ADR README and index**

Set `tutorial-engine/docs/adr/README.md` to:

```md
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
```

- [ ] **Step 5: Add scoped contributor guidance**

Insert this section after the `# Software factory tutorial` title in `AGENTS.md`:

```md
## Tutorial-engine architecture decisions

Record durable tutorial-engine architecture decisions as ADRs in `tutorial-engine/docs/adr/`. Run ADRgen
from `tutorial-engine/`, keep `tutorial-engine/docs/adr/README.md` indexed, and supersede accepted ADRs
rather than rewriting them. This convention does not apply to the tutorial curriculum or lesson
specifications.
```

- [ ] **Step 6: Verify the record, guidance, and engine checks**

Run:

```sh
cd tutorial-engine
adrgen list
npm run check
```

Expected: `adrgen list` reports ADR 0001 as accepted, and `npm run check` exits successfully.

- [ ] **Step 7: Commit the convention and initial record**

```sh
git add AGENTS.md tutorial-engine/docs/adr/README.md \
  tutorial-engine/docs/adr/0001-use-architecture-decision-records.md
git commit -m "docs: adopt tutorial engine ADRs"
```
