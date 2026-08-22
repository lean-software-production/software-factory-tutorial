# Flat Optional Parts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development.

**Goal:** Flatten workbook lessons, make part grouping an optional `workbook.md` manifest, and preserve part narrative in `parts/*.md`.

**Architecture:** Lessons are globally named directories under `lessons/`. `workbook.md` optionally assigns them to ordered part IDs; each assigned part loads prose from `parts/<id>.md`. When omitted, the loader discovers all flat lessons in numeric order and the UI renders no part grouping. Canonical lesson references use the flat lesson directory ID.

**Spec:** Approved chat design, 2026-08-22.

## Tasks

### Task 1: Add flat optional-parts loader contract
- Modify `tutorial-engine/src/workbook/contract.ts`, `load.ts`, `lesson-links.ts`, and workbook contract/UI tests.
- TDD: test optional parts, unknown/duplicate/omitted lesson validation, flat fallback, and flat canonical references; run focused tests red then green.

### Task 2: Migrate production and eval curriculum files
- Move all production lessons to `lessons/001-*` … `lessons/013-*`; move part narratives to `parts/*.md`; declare both parts in `workbook.md`.
- Flatten matching eval fixture lessons and update their manifests, hard-coded IDs, and scenarios.
- Run seed, workbook, and eval tests.

### Task 3: Verify integrated UI and repository
- Verify flat rail/no-part mode and optional part headings in UI tests.
- Run `npm run --workspace=tutorial-engine check`, `npm run check`, and the workbook production build.
