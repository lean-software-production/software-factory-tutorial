# V2 tutor Markdown manifests: implementation plan

## Goal

Replace the workbook's split lesson sources with Markdown manifests that keep learner-facing content
in Markdown and tutor-only guidance in frontmatter. Apply one consistent title convention across the
workbook, parts, lessons, and blocks.

The migrated lesson 001 is the reference content shape. The current TypeScript loader, browser UI,
and tests still expect the old layout and must be migrated before the tutor can load it.

## Content contract

Every authored document has YAML frontmatter and a title heading. An empty frontmatter map is valid
when the document has no structured fields. The path determines the document kind; do not add a
`kind` field.

| Document | Location | Title | Structured fields |
| --- | --- | --- | --- |
| Workbook | `workbook.md` | Exactly one H1 | Workbook manifest fields, if any |
| Part | `lessons/<part>/part.md` | Exactly one H1 | Part manifest fields, if any |
| Lesson | `lessons/<part>/<lesson>/lesson.md` | Exactly one H1 | `durationMinutes`, `outcomes`, ordered `blocks` |
| Block | `blocks/<id>.md` | Exactly one H2 | `type` and type-specific tutor data |

Lesson titles, part titles, and workbook titles are Markdown headings, never frontmatter values.
The first paragraph after a lesson H1 is its dek. A lesson has no authored opening section:
its duration and outcomes are structured data that the tutor renders before the first block.

A lesson's `blocks` field contains only ordered IDs. The loader resolves ID `example` to
`blocks/example.md`. The block filename supplies its ID.

All blocks belong to the required sequence. There is no `required` flag. A block without a learner
task advances through Continue or scroll-to-end; it does not complete merely because it was shown.

Interactive blocks (`terminal-practice` and `reflection`) require a private `tutor` frontmatter
field. It records the canonical command where useful, expected observation, acceptable variation,
coaching clues, and the reason for the exercise. It must never appear in the browser's learner-facing
state.

Learner-facing terminal tasks, commands, and reflection questions are Markdown body content. A
terminal exercise can give an exact fenced command or only task clues, depending on the lesson.

## Phase 1: Replace the content contract

Update `tutorial-engine/src/workbook/contract.ts`.

1. Replace the hero/opening lesson model with a lesson containing `id`, `title`, `dek`,
   `durationMinutes`, `outcomes`, and ordered blocks.
2. Remove `TerminalMode`, `OBSERVED_TERMINAL_MODE`, hero/opening models, `required`, `source`,
   `command`, `context`, `expectedObservation`, `help`, `prompt`, and `label` from the authored
   contract.
3. Retain supported block types. Each block receives its filename-derived ID, H2-derived title,
   learner-visible Markdown, and type-specific private metadata.
4. Require a non-empty `tutor` field on terminal-practice and reflection blocks. Reject it for
   narrative and lesson-transition blocks unless a later type design explicitly adds a use for it.
5. Make schemas strict and location-specific: reject unknown fields, invalid duration values,
   empty outcomes, duplicate IDs, unsupported block types, and operational learner content stored
   in frontmatter.
6. Validate that workbook, part, and lesson source has exactly one H1 and every block has exactly
   one H2. Treat absent, duplicate, or wrong-level headings as authoring errors.

## Phase 2: Load by convention

Update `tutorial-engine/src/workbook/load.ts`.

1. Load `workbook.md`, each `part.md`, and each `lesson.md` as Markdown manifests.
2. Remove all loading and fallback paths for `hero.md`, `opening.md`, and `lesson.yaml`.
3. Extract document titles from their H1 and remove the title heading from rendered Markdown.
4. For lessons, extract the first body paragraph as the dek, load duration and outcomes from
   frontmatter, and load each ordered block from `blocks/<id>.md`.
5. For blocks, extract the H2 as title, retain the remainder as learner Markdown, and assemble
   private tutor data without serializing it to public clients.
6. Reject missing listed files, duplicate IDs, and unlisted block files so the curriculum cannot
   silently contain dead material.
7. Once migration starts, make missing or invalid `lesson.md` an authoring error rather than
   returning a partly available legacy lesson.

## Phase 3: Make the terminal embedded and tutoring private

Update `tutorial-engine/src/workbook/server.ts`, `tutorial-engine/src/workbook/terminal.ts`,
`tutorial-engine/src/workbook/reflection.ts`, and their types.

1. Remove terminal-mode selection and external-terminal fallback. All terminal practice uses the
   embedded, observed terminal.
2. Keep the existing loopback-only, isolated-container, one-client, transcript-limit, and
   server-owned verification protections.
3. Pass the interactive block's private `tutor` brief and learner-visible Markdown to terminal
   observation and reflection facilitation.
4. Derive an optional command-insertion value from a learner-visible fenced shell block. If an
   exercise supplies only clues, do not invent a command to insert.
5. Use private tutor guidance to assess expected observations and acceptable variants; do not
   require exact model wording where the lesson says wording may vary.

## Phase 4: Replace progression flags with sequence progression

Update `tutorial-engine/src/workbook/events.ts` and server event handling.

1. Remove all filtering and state based on `required`; every block listed in `lesson.md` is part
   of completion.
2. Add a generic continuation event for narrative and transition blocks.
3. Advance a no-task active block from either an explicit Continue control or an end-of-scroll
   event. Guard against duplicate requests and reject events for inactive blocks.
4. Preserve terminal verification as the completion criterion for terminal practice.
5. Preserve reflection facilitation and explicit acceptance before reflection completion.
6. Project progress across the ordered curriculum so a completed lesson selects the next lesson,
   rather than leaving the workbook fixed on the first lesson.

## Phase 5: Render the new lesson shape

Update `tutorial-engine/web-workbook/src/main.tsx` and
`tutorial-engine/web-workbook/src/styles.css`.

1. Render each lesson in this order: H1 title, dek, duration pill, fixed “What you will learn”
   section, outcomes, then ordered blocks.
2. Reuse or adapt the existing Markdown renderer in `tutorial-engine/web/src/markdown.tsx` so
   learner content supports headings, prose, lists, emphasis, and fenced shell commands.
3. Render block H2 titles and body Markdown. Never render the private `tutor` field.
4. Make the embedded terminal the only terminal experience. Offer Insert command only when the
   visible Markdown has a fenced shell command.
5. Add Continue controls and an end sentinel or `IntersectionObserver` for narrative and
   transition blocks. Both paths submit the same continuation event.
6. Update the lesson rail and active-lesson behaviour to use the multi-lesson progress projection.

## Phase 6: Migrate the curriculum

1. Retain lesson 001 as the reference migration, then migrate lessons 002–013.
2. Move the title in `workbook.md` from frontmatter into an H1; add H1 titles to both part files.
3. For every remaining lesson, create `lesson.md`, move duration/outcomes/block order into its
   frontmatter, and move title/dek into its H1 and first paragraph.
4. Delete each lesson's obsolete `hero.md`, `opening.md`, and `lesson.yaml` files.
5. Move block type-specific metadata into each block's frontmatter; turn each block title into an
   H2; put learner prompts and commands in the body.
6. Add concrete private tutor guidance to every terminal-practice and reflection block.
7. Preserve the curriculum's established terminology, lesson order, and prose constraints.

## Phase 7: Update tests and verify

Rewrite fixtures and assertions in:

- `tutorial-engine/test/workbook-contract.test.ts`
- `tutorial-engine/test/workbook-events.test.ts`
- `tutorial-engine/test/workbook-server.test.ts`
- terminal and reflection tests
- browser smoke and Markdown-rendering coverage

Test strict heading/frontmatter validation, convention-based block discovery, tutor-field privacy,
embedded-only terminal operation, exact-versus-clue command presentation, ordered progression,
Continue and scroll completion, and advancing through multiple lessons.

Run after implementation:

```sh
cd tutorial-engine
npm run check
npm run build
npm run browser:smoke
```
