# Mermaid rendering in the workbook

## Status

Proposed — 2026-08-26

## Problem

The workbook accepts Mermaid fenced blocks in authored Markdown but displays them as ordinary,
copyable source code. `Markdown` in `web-workbook/src/markdown.tsx` sends every `<pre>` element to
`CodeBlock`; `react-markdown` and `rehype-highlight` do not render diagrams.

The same component also renders model-generated tutor replies and live feedback. Rendering every
`mermaid` fence would give generated text an SVG-producing capability that curriculum Markdown has
and should have deliberately, rather than by default.

## Decision

Render Mermaid only when the caller identifies the Markdown as authored curriculum. Treat every
other Markdown value as generated and retain its Mermaid fences as ordinary copyable code.

Use Mermaid directly, rather than a React wrapper. Load it in the browser only when an authorised
diagram is mounted. Initialise it with `startOnLoad: false`, `securityLevel: "strict"`, and
`htmlLabels: false`. A parse or render error must show the original source through the existing
`CodeBlock` component.

This policy enables diagrams in parts and lesson blocks without changing the trust boundary for
tutor output. The known authored diagrams are in:

- `tutorial/parts/validation-loop.md`
- `tutorial/lessons/004-feed-the-findings-back/blocks/the-loop-you-just-ran.md`
- `tutorial/lessons/007-compose-and-branch/blocks/key-concept.md`

## Implementation

### 1. Add the dependency

Add `mermaid` to `tutorial-engine/package.json` and update the root `package-lock.json` with:

```sh
npm install --workspace=tutorial-engine mermaid
```

The workbook is built by Vite. A dynamic import in the diagram component will keep Mermaid out of
the initial bundle and needs no Vite configuration change.

### 2. Add a policy-aware Markdown API

In `tutorial-engine/web-workbook/src/markdown.tsx`, add an explicit Markdown source policy, such as:

```tsx
<Markdown source="authored">{content}</Markdown>
```

`source` defaults to `generated`. Thread the policy through the `pre` renderer. When it sees a
`language-mermaid` block and the source is `authored`, route the block to `MermaidDiagram`.
Otherwise, continue through `CodeBlockFromPre` unchanged. `FileExcerptCodeBlock` remains code-only.

`MermaidDiagram` should:

1. obtain the original fence text and a collision-safe diagram ID;
2. dynamically import Mermaid inside `useEffect` and initialise it once with the chosen strict
   configuration;
3. render the result into a scoped diagram container;
4. ignore late asynchronous results after unmount or after its source changes; and
5. replace its loading state with the existing copyable source block when import, parsing, or
   rendering fails.

Do not enable raw Markdown HTML. Mermaid output is the only SVG inserted, and it comes from the
strictly configured Mermaid renderer.

### 3. Mark only curriculum content as authored

Update `tutorial-engine/web-workbook/src/timeline-thread.tsx` so a course record renders with
`source="authored"` only when its existing provenance is `source === "authored"` and its
presentation is `course`. Main-tutor, block-tutor, hint, review, and learner records remain
generated or plain text.

Update `tutorial-engine/web-workbook/src/workbook-ui.tsx` so directly rendered curriculum values
receive `source="authored"`:

- narrative, terminal-practice, editor-practice, reflection, and transition block Markdown;
- the workbook introduction; and
- part Markdown.

Live terminal/editor feedback and the completion summary remain generated. This matters even if the
current timeline presentation is the usual route: the direct views are still Markdown call sites and
must preserve the same boundary.

### 4. Style diagrams as bounded workbook content

Add scoped styles in `tutorial-engine/web-workbook/src/styles.css` for a diagram container and its
SVG. The container should have the same vertical rhythm as a code block, fit the Markdown column,
and scroll horizontally when a diagram is wider than its card. The SVG should preserve its aspect
ratio and sit on a legible, paper-like surface.

Keep the selectors local to the diagram component. Do not apply global SVG styling, and retain the
existing code-block styling for fallback source.

## Tests

Extend `tutorial-engine/test/markdown.test.ts` to cover:

1. an authored Mermaid fence selecting the diagram container rather than the generic code block;
2. a generated Mermaid fence remaining literal, copyable code;
3. ordinary highlighted code and `FileExcerptCodeBlock` behaviour staying unchanged; and
4. static server rendering not importing Mermaid or depending on `window`.

Add browser/JSDOM coverage with Mermaid mocked to verify strict initialisation, successful SVG
rendering, failure fallback, and no stale state update after unmount or a source change.

Extend `tutorial-engine/test/timeline-thread.test.tsx` to prove that an authored course record can
use the diagram path while a tutor record with the identical fence cannot.

Extend `tutorial-engine/test/workbook-ui.test.tsx` to prove the same distinction for direct
curriculum rendering and generated live feedback. Add CSS contract assertions for the diagram
container's width and overflow protections.

## Verification

Run:

```sh
npm run --workspace=tutorial-engine check
npm run --workspace=tutorial-engine build:web:workbook
npm run check
```

Then run the workbook and inspect the Part 1 diagram and the diagrams in lessons 004 and 007 at both
wide and narrow viewport widths. Confirm that a malformed authored diagram reveals its copyable
source and that a Mermaid fence emitted by a tutor remains source code.
