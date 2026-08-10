# Workbook tutor redesign

## Aim

Replace the current chat-transcript tutor with a continuous digital workbook. A learner reads one long,
scrolling document that combines authored explanation, exercises performed in their own editor and
terminal, and small contextual interactions with a tutor.

The document is not a dashboard and is not an open chat conversation. It is a structured lesson whose
fixed argument remains stable while specific blocks adapt to the learner's observed work.

## Experience principles

### The workbook is one document

A tutorial is one continuous document containing all its lessons as chapters. Scrolling is the primary
way to move through it. The learner may read later narrative, but their progress through the curriculum
is independent of how far they have scrolled.

The document uses a squared-paper treatment. It should feel like a working notebook: generous space,
large editorial typography, a persistent margin, and exercise elements placed on the page. It should not
look like a product dashboard or a stack of chat cards.

### Navigation has two levels

The persistent left rail is a curriculum outline:

- It always lists every lesson, grouped by part.
- It marks lessons as done, active, or ahead.
- The lesson currently in the viewport is the only expanded lesson in the rail. Its local block outline
  is visible there.
- Clicking a lesson scrolls to its chapter in the document.
- Scrolling into another chapter collapses the old lesson outline and opens the new one.

The lesson in view and the learner's active lesson are different state. A learner may scroll into an
upcoming chapter to read it. Its row and content must still show that it is ahead of the learner's
progress.

A resumed session returns to the active block in the active lesson, not to the document's first line.

### Narrative is open; consequential work is progressive

A learner can read the authored narrative ahead. That narrative should be visibly veiled by a translucent
layer until the learner reaches it, without being hidden or made inaccessible.

Exercises whose value depends on prior work are held until their prerequisites are met. The learner can
see that such an activity is coming, but not yet perform its consequential action. Scrolling never
changes an activity's availability.

### Visuals earn their space

A lesson may use a large, scroll-driven visual scene when it explains a relationship more clearly than
prose and code: a loop, a branch, a capability boundary, a growing record, or another process whose
shape matters. It is not a required block type and must never be decorative motion.

A visual scene has an authored storyboard: the prose beats, the visual state at each beat, and an
accessible text equivalent. Small diagrams and ordinary prose remain the right choice for many ideas.

### Help is local and deliberate

The page avoids a permanently open text chat. Each block exposes the help appropriate to its task, such
as:

- Review my change
- Show the next edit
- Show the complete block
- Explain this command
- I saw something different
- Why does this work?

The normal controls handle anticipated needs without a model call where possible. A `Something else`
action opens a small free-text prompt in that same block. Tutor responses appear inline with the block,
not in a page-wide transcript.

Quizzes are reflection prompts, never mastery gates. An incorrect answer explains the misconception and
offers contextual clarification. It does not prevent the learner continuing.

## Learner work and observation

Learners continue to use their own editor and terminal. The workbook presents the file, command,
terminal context, expected observation, and next action, but does not initially embed an editor or a
terminal.

A filesystem watcher is an active-step sensor, not a live workspace feed:

- It watches only paths relevant to the active exercise block.
- It ignores unrelated edits and regenerated output by default.
- It debounces editor save patterns, including atomic rename-on-save.
- It distinguishes external learner edits from tutor edits already known through tool audit events.
- A detected change shows a quiet local confirmation and offers review; it does not review
  automatically.
- Observing a file change can make the next action ready, but cannot by itself complete a lesson.

The engine still requires appropriate evidence for completion: a required observation, an exercise result,
a reflection, or an explicit lesson-ending action.

### State is derived from events

The workbook records append-only facts about what it can observe or what the learner explicitly does. It
does not claim to log every action the learner takes in an external editor or terminal. A projection derives
active and completed blocks, lesson progress, and resumption state from those events.

The initial store is a local JSONL event log under `factory/.tmp/workbook/`, with an optional rebuildable
projection cache beside it. The workbook server is its single writer. A database is not required for this
single-user, local first iteration; reconsider SQLite only if concurrent writers, cross-run queries, or
multi-user use makes an append log inadequate.

## Lesson contract

Lesson prose remains authored in Markdown. Each lesson gains a small structured manifest that lets the
engine render the document and operate its interactive blocks. The manifest is deliberately minimal at
first and may evolve after the pilot.

```yaml
id: "006"
title: Put the validator on a read-only harness

keyConcepts:
  - A boundary enforced by the harness is stronger than a prohibition in a prompt.
  - The harness supplies evidence when the validator cannot run the commands itself.

learningOutcomes:
  - Explain why removing a capability is stronger than asking an agent not to use it.
  - Build a read-only validator harness that receives labelled evidence.
  - State the guarantee and limitation of a closed evidence set.

blocks:
  - narrative
  - scrollytelling
  - editor-practice
  - terminal-practice
  - experiment
  - reflection
```

The manifest will eventually link key concepts to a published taxonomy. It does not need taxonomy IDs or
a formal taxonomy schema in this iteration. Existing glossary material is reference material, not yet a
runtime dependency.

The full contract must grow to identify block IDs, authored source, prerequisites, observed paths, and
completion evidence. Those details are implementation work, not prerequisites for agreeing the initial
shape.

## Block vocabulary

The engine must support these instructional blocks. A lesson uses only the ones its argument requires.

| Block | Purpose |
| --- | --- |
| Narrative | Fixed authored explanation, trade-off, transition, or pressure test. |
| Scrollytelling | An authored visual scene whose state changes with the associated prose. |
| Diagram | A static visual with a text equivalent. |
| Editor practice | A learner changes a specified file in their own editor. |
| Terminal practice | A learner runs a command in their own terminal and observes an expected result. |
| Decision | A learner chooses a meaningful design option before building. |
| Evidence review | A learner inspects a diff, output, log, process state, or record. |
| Experiment | A learner deliberately tests a claimed boundary or failure mode, then restores the work. |
| Reflection quiz | A non-gating check for understanding, with contextual help. |
| Inline tutor help | A bounded review, hint, explanation, or diagnosis attached to another block. |
| Lesson transition | A recap and the choice to pause or move into the next lesson. |

## Curriculum work is an implementation workstream

The engine cannot be considered complete merely because it renders a manifest. Converting a lesson
requires human curriculum work, with a review gate for every lesson:

1. Articulate its key concepts as precise, mechanism-based claims.
2. Write observable learning outcomes in terms of what the learner can explain, build, demonstrate, or
   inspect.
3. Divide the specification into fixed narrative and typed interactive blocks.
4. Write and edit the fixed narrative: opening, explanation, transitions, trade-offs, pressure test, and
   closure.
5. Create a visual storyboard and accessible equivalent for every diagram or scroll-driven scene.
6. Define the learner evidence that makes each consequential block ready or complete.
7. Review the finished lesson in the workbook before migration is accepted.

This work belongs in the implementation plan beside engine tasks, with named human review points. It is
not a bulk content conversion delegated to the tutor.

## Migration and play-test order

Migrate and play-test one lesson at a time. Lesson 001 is the first vertical slice: it establishes the
continuous document, navigation, fixed narrative, key concepts, learning outcomes, external-terminal
practice, reflection, and contextual help without requiring a watcher.

Lesson 002 follows only after lesson 001 has human curriculum approval and a learner play-test. It is the
first watcher lesson because it asks the learner to write files. Later lessons introduce further engine
capabilities only when their curriculum reaches them.

Lesson 006 remains the first complex visual-and-experiment milestone. It contains a precise boundary
concept and trade-off, a three-stage harness → evidence → validator visual scene, an external-editor
exercise observed by the watcher, terminal evidence inspection, an intentional failure experiment, a
reflection quiz, and a transition into lesson 007.

Every lesson establishes or refines the authoring pattern, visual language, watcher interaction,
inline-help grammar, and curriculum review standard before the next lesson migrates.

## Non-goals for this iteration

- An embedded editor or scoped terminal. Blocks must be designed so either can be added later.
- A persistent chat transcript or open chat as the primary interaction model.
- A complete concept-taxonomy schema or publishing system.
- A live workspace activity feed.
- A database or multi-writer event store.
- Automatic lesson completion from filesystem changes.
- Mandatory scrollytelling in every lesson.
