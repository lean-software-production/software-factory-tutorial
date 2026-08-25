# 10. Use the workbook tutor as the only tutorial interface

Date: 2026-08-25

## Status

accepted

## Context

The engine retained its original browser tutor beside the workbook tutor while the workbook was
introduced. This leaves two launch paths, browser applications, state formats, and sets of runtime
code. Some workbook modules still depend on utilities owned by the original tutor, so retaining that
code also obscures the workbook's actual boundary.

## Decision

Use the workbook tutor as the only supported tutorial interface. Its root launcher is
`npm run tutorial:workbook`, and the published executable starts the workbook CLI. The engine keeps
compatibility for earlier workbook event and attempt records, but does not read, migrate, or delete
state from the removed browser tutor.

Move utilities the workbook needs into workbook-owned modules. Remove the original browser UI,
server, CLI, lesson runtime, protocol, validation runtime, and their tests rather than retaining a
compatibility layer.

## Consequences

Learners and maintainers have one supported tutorial workflow and one state model. Builds and package
contents contain only workbook assets and runtime code.

The former browser tutor and its Part 2 shortcut and reset flow are unavailable. Existing ignored
browser-tutor state remains inert on disk; a learner with that state starts the workbook at its
introduction instead of resuming or converting it.