# Specification-ordered tutoring design

## Goal

Keep teaching order specific to each tutorial iteration. The tutoring engine should guide learners through the current specification without imposing an abstract "heart-first" order.

## Teaching flow

When a learner selects “I’ll do it,” the tutor gives a short outline and then teaches the small steps in the implementation order stated by the current specification. Each step states its outcome, identifies the relevant file and nearby code, explains the intent, shows a small snippet, and offers the existing progressive-help choices.

The first refactoring-loop specification defines its own order: start with the Bash `while` loop, add its pause and control flow, add the Pi invocation, then write `refactor.md`. Later specifications may define a different order when that better teaches their subject.

## Changes

- Remove the engine prompt’s "heart of the change" and "work outward" direction.
- Replace its related test with an assertion that the tutor follows the current specification’s stated order.
- Update the first iteration specification to state the loop-first implementation order explicitly.
- Update planning and evaluation documents that describe heart-first teaching so they instead describe specification-ordered teaching.

## Validation

Run the tutorial engine typecheck and test suite. Manually begin the tutorial and confirm that the first guided step follows the sequence in the first iteration specification, beginning with the Bash loop.
