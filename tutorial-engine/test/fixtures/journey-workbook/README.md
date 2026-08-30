# Journey workbook fixture

This fixture is shaped for the recorded workbook UX journey, not for learner curriculum.

It is a sibling of `visual-workbook` so screenshot-sensitive visual approvals keep their own stable content. The recorder copies this directory into `test/.tmp/workbook-ux/latest/input/` before every run and starts the real workbook server against that copy. Authored fixture files are never mutated by the recorder.

The content is intentionally linear:

1. workbook, part, and lesson preamble;
2. a tall narrative block with enough prose to scroll;
3. an `editor-practice` block backed by `workspaces/refactor-line/factory/answer.md`;
4. a `terminal-practice` block for the protocol-aware fake PTY.
