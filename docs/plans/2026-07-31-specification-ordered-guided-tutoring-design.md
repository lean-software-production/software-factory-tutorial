# Specification-ordered guided tutoring design

## Goal

Make the tutorial gentle for learners who choose to implement a step themselves. Teach each iteration in the implementation order stated by its specification, rather than imposing an abstract teaching order.

## Teaching flow

When a learner selects “I’ll do it,” the tutor first gives a short outline of the few conceptual moves in the current iteration. It then starts the first small guided step immediately and continues in the implementation order stated by the current specification.

Each step:

1. States the visible outcome it will achieve.
2. Follows the current specification’s stated implementation order.
3. Identifies the file and nearby code.
4. Explains the intent and shows a small code snippet the learner can type.
5. Offers three next actions: confirm the step is complete, ask for exact typing instructions, or ask the tutor to make that step.

The tutor keeps each edit small. It leaves validation, errors, and defensive code until they teach the current lesson or become necessary.

## Implementation

Update the tutorial coaching prompt and the `offer_choices` tool description. No browser protocol or UI changes are required: the existing choice event already supports the three actions, and markdown presentations can show the contextual code snippets.

## Validation

Add focused tests for the tutoring instructions or their extracted policy, if practical. Run the tutorial engine’s existing typecheck and test suite. Manually begin the tutorial and verify that the learner path starts with an outline, then follows the active specification’s implementation order with snippet-led steps. For the first iteration, the first guided step is the Bash loop.
