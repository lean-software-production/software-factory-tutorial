# 8. Separate work acceptance from block completion

Date: 2026-08-24

## Status

accepted

## Context

The workbook needs a type-independent point at which it can render the next block before the learner
moves into it. The earlier design treated a block's ability to continue as `canComplete` and used an
invisible end sentinel to detect scrolling. That makes the next rendered block depend on type-specific
completion checks and leaves scrolling dependent on a small marker at the bottom of the page.

An evaluated exercise has one meaningful fact: the learner's work was accepted. A reading block has no
evaluated evidence, but it can be accepted immediately when it becomes active. Both should drive the
same successor-preparation mechanism.

## Decision

Give every block a uniform `workAccepted` condition. No-work blocks set it immediately on activation;
evaluated blocks set it when their evidence is accepted. Record the transition with a generic
`work_accepted` event.

Treat display/progression as `unready`, `ready`, `active`, and `completed`. When the current block's work
is accepted, render exactly one successor as `ready` below a page-break. A ready block has authored
content but is not an active interaction, sidebar, direct-link, or conversation target.

Crossing the ready successor's reading line completes its predecessor and activates that successor. An
explicit Continue control and tutor tool invoke the same completion operation and promote the same ready
successor.

## Consequences

The server has one durable, type-independent transition that prepares a successor. The learner scrolls to
the next authored block rather than an invisible sentinel, while buttons and tutor tools preserve the
same progression path.

The projection must distinguish ready from active blocks, and the browser must prevent ready blocks from
acting as ordinary navigation or interaction targets. Existing sentinel-based UI and tests are replaced
by successor-crossing behaviour.
