---
type: editor-practice
path: factory/refactor.md
tutor: |-
  Check that factory/refactor.md gives the doer one concrete behaviour-preserving calculator
  refactoring job, requires direct file edits, forbids tests, npm, and shell commands, and asks for
  a concise response. Accept equivalent wording and a different small refactoring target, but not a
  prompt that asks for multiple changes, permits command execution, or asks the doer to check its
  own work.
---

## Write the doer prompt

Create `factory/refactor.md`. Nothing else tells the doer what you want, so keep the prompt direct:

- It is working on the natural-language calculator written in TypeScript.
- It should choose one small, behaviour-preserving refactoring and make it.
- It must edit files directly.
- It must not run tests, npm, or shell commands.
- It should keep its response concise.

The prompt can use your words. The boundary cannot change: the doer writes the work product, but the
evidence stays outside the doer.
