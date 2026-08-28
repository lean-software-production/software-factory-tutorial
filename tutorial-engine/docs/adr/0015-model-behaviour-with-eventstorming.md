# 15. Model behaviour with EventStorming

Date: 2026-08-28

## Status

accepted

## Context

The engine has accumulated behaviour described in implementation terms: handlers, timers, sockets,
and stores. That vocabulary makes it hard to establish what happened from the learner's point of
view, and it lets a technical action such as a model request be mistaken for a domain fact. The
terminal coaching failure made the cost visible: a paused byte stream was treated as a learner
attempt because the system had no shared model of command submission, command completion, review,
and display.

The project needs a common way to discuss, design, and test behaviour before code. This is broader
than the workbook terminal. Existing code and records use mixed terminology and will require a
separate audit and migration plan.

## Decision

Use EventStorming, in the style developed by Alberto Brandolini, to model new behaviour and material
behaviour changes before implementation.

Start discussions with the actors, commands, past-tense domain events, policies, aggregates, and
external effects involved. A command expresses intent; a domain event records a fact that has
already happened; a policy reacts to a fact; and a request to an external system is an effect, not
by itself a domain event. Name events in the domain's past tense, for example `Terminal command
submitted`, rather than after a handler or transport message.

For each material feature, retain the resulting command/event/policy map with its design record or
feature specification. Derive acceptance tests from event slices: given these prior events, when
this command occurs, these events and public state transitions result. The test must run the real
behavioural boundary where practical and stub only external systems such as models, browsers, and
terminal processes.

The session event log is the canonical record of durable domain facts. Its browser, tutor, and
diagnostic projections are explicit audiences, not different sources of truth. Private facts may be
recorded there but must be excluded from any projection not entitled to read them.

## Consequences

Design discussions gain a shared language that separates learner intent from terminal mechanics and
model-provider effects. Tests can assert observable event sequences and projections rather than
incidental calls to internal methods.

This does not rename all existing events or make every runtime trace a domain event immediately.
The project needs a follow-up audit to identify existing behaviour that should be remodelled,
renamed, migrated, or left as technical instrumentation. EventStorming adds an up-front modelling
step and requires maintainers to keep event names and their audience projections honest.
