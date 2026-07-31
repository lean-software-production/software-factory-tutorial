# Markdown table rendering design

## Goal

Render GitHub-Flavored Markdown tables correctly in the tutorial engine’s browser UI.

## Chosen approach

Configure every `ReactMarkdown` instance in the transcript and presentation cards with the `remark-gfm` plugin. Add CSS for semantic table elements so tables remain legible within cards and can scroll horizontally on narrow screens.

## Scope

- Add `remark-gfm` as a tutorial-engine dependency.
- Apply the plugin to assistant messages, learner messages, and markdown presentations.
- Style table, header, data-cell, and container overflow behavior.
- Add a focused rendering test for a pipe-delimited Markdown table.

## Alternatives considered

- Build a custom table parser or renderer: unnecessary because the Markdown renderer already supports plugins.
- Instruct the tutor not to emit tables: reduces the tutor’s expressive vocabulary and leaves ordinary Markdown unsupported.

## Error handling

The renderer continues to treat malformed tables as ordinary Markdown. No protocol or tutor-agent behavior changes.

## Verification

Run the tutorial-engine typecheck and test suite. Manually verify that a table has headers, rows, borders, and horizontal scrolling when needed.
