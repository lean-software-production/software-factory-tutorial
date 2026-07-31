# Code highlighting and copy design

## Goal

Make tutorial code easy to read and reuse. Highlight fenced Markdown code blocks and tutor file excerpts, and let learners copy their original text with one control.

## Components

Add `rehype-highlight` for fenced Markdown syntax highlighting. Render fenced blocks through a reusable React code-block component that receives the raw text and language. File-excerpt cards will use the same component, deriving language from the file extension.

Inline code remains inline and keeps its existing styling.

## Copy interaction

Each block has an accessible copy button. It copies the raw, unhighlighted source through the Clipboard API, changes to “Copied” on success, and shows a readable failure state when the browser denies clipboard access. Highlighting never changes the copied text.

## Styling and safety

Use a Highlight.js theme alongside the existing code-block layout. Keep Markdown’s current safe rendering model: highlighting transforms the parsed Markdown tree and does not enable raw HTML.

## Validation

Add focused renderer tests for language-labelled fenced code and copyable file excerpts. Run the tutorial engine check and web build, then manually verify copy feedback and highlighting in the browser.
