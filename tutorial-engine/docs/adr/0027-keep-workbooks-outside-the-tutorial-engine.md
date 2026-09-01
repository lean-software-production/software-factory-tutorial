# 27. Keep workbooks outside the tutorial engine

Date: 2026-09-01

## Status

accepted

## Context

The tutorial engine can load, render, run, and evaluate workbook-shaped content, but the engine package is not the owner of any production workbook. A consuming repository, product, or launcher owns its authored curriculum, workbook fixture directories, package manager choices, and play-through expectations.

Defaulting from the engine to one repository's authored workbook, baking that workbook's dependencies into the generic terminal image, or pinning deterministic engine tests to authored lesson prose reverses the intended dependency direction. It makes the engine know about a caller and turns content edits into engine-contract changes.

## Decision

Workbook content is caller-owned runtime input. The dependency direction is consuming workbook/launcher -> tutorial engine, never tutorial engine -> consuming workbook/launcher.

The engine must not default to, import, read, identify, or special-case this repository's authored tutorial or any other consuming workbook. Commands that operate on a workbook require the caller to provide an explicit workbook target.

Deterministic engine tests may validate generic schema, parsing, session, terminal, and evaluation mechanics only against engine-owned synthetic fixtures. They must not pin authored workbook content or enforce consuming repository package wiring. Human or agentic play-throughs of authored workbooks are allowed and useful, but they are dynamic, non-gating checks owned by the workbook authors.

The workbook terminal image is generic. It provides Node, Git, jq, the pinned Pi CLI, `/workspace`, and the learner home. It does not bake caller packages, lockfiles, authored templates, or `node_modules` symlinks. Consuming launchers provision runtime dependencies through the explicit runtime-provision boundary when their workbooks need them.

## Consequences

Engine tests become less effective as automated copy protection for authored curriculum regressions. Authors are responsible for reviewing and editing content changes directly, and for using occasional human or dynamic agent play-throughs as non-gating observations before release. They should not replace the removed authored-workbook lane with deterministic content-contract tests that pin workbook prose, IDs, order, counts, filenames, commands, vocabulary, or lesson-specific learner behavior.

The engine package is more reusable and can evolve its generic contracts without importing caller policy. Consuming repositories must be explicit about workbook paths and runtime provisioning, which makes integration seams more visible.

Synthetic fixtures may keep arbitrary IDs, paths, and content such as `refactor-line` or `tetris` when they exercise engine mechanics. Those names do not create a contract with any authored workbook.
