# Play-test findings: material

Transcript date: 2026-09-01 (the Ensembleworks server's date boundary).

## Vocabulary and boundaries are not yet coherent

The material uses or implies competing meanings for *harness*, *factory*, *orchestrator*, *seed*,
*validation*, and *turn*. In particular, a harness is used for a larger workflow where the
discussion expected a distinct orchestrator/factory boundary. The seed copy also differed between
the lesson source and YAML.

Expected: one canonical definition per term, used consistently across the workbook, lesson files,
and glossary; introduce a term before relying on it. Explain the doer/checker boundary as distinct
jobs and prompts, rather than as evidence being inside or outside one actor.

Evidence: 18:21:10–18:22:12; 18:25:31–18:32:32; 18:36:27–18:39:55; 19:01:23–19:08:33;
19:21:49–19:23:12.

## Refactoring tools arrive before their purpose

Lesson 004 asks the learner to use `quality.mjs` and presents its findings before establishing why
refactoring needs a quality baseline. The output reads as a detailed list of complaints rather than
useful evidence.

Expected: introduce the refactoring question and the role of the quality check before its command;
then state what a learner should notice in its output. Keep tool-specific detail secondary.

Evidence: 18:23:29–18:25:25.

## The doer-harness task feels pre-filled

The supplied complete harness left no intentional learner decision, giving the step a
fill-in-the-blanks feel.

Expected: leave a meaningful, teachable part for the learner to author or choose before the step is
accepted.

Evidence: 18:22:23–18:22:51.
