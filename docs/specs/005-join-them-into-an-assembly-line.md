# Repeat the validation loop

Repeat the doer-and-validator sequence, but leave decisions with the human.

## Key concept

Part 1 completed one validation loop by hand: a doer changed the calculator and a validator assessed that change against `success.md`. This lesson repeats the whole sequence. Bash owns the loop and pauses after each validation so the human can read the verdict before starting another turn.

Bash does not yet interpret the verdict, choose a repair prompt, or recover automatically.

## Decision flow

Show this Mermaid diagram when introducing the lesson:

```mermaid
flowchart TD
    Start([Start / press Enter]) --> Doer[Doer\nrefactor.md + success.md]
    Doer --> Validator[Validator\nvalidate.md + success.md]
    Validator --> Pause[Pause for human validation]
    Pause --> Start

    classDef start fill:#fef3c7,stroke:#d97706,color:#78350f,stroke-width:2px
    classDef doer fill:#dbeafe,stroke:#2563eb,color:#172554,stroke-width:2px
    classDef validator fill:#dcfce7,stroke:#16a34a,color:#14532d,stroke-width:2px
    classDef pause fill:#fce7f3,stroke:#db2777,color:#831843,stroke-width:2px
    class Start start
    class Doer doer
    class Validator validator
    class Pause pause
```

## Implementation order

Keep `factory/refactor.md`, `factory/validate.md`, and `factory/success.md` from the previous lessons. Teach and build this lesson in this order. Complete each small step before moving to the next one:

1. **Start the Bash loop.** Update `factory/run.sh`. Keep its setup and both agent invocations, then add the `while true; do ... done` structure that repeats one complete validation loop. Leave a temporary placeholder in the loop body while establishing the structure.
2. **Add the pause and control flow.** Replace the placeholder with a `read -r -p` pause after the validator has reported its findings. The learner must press Enter before the next turn. Ctrl-C stops the shell and therefore the factory.
3. **Announce each role.** Before each invocation, announce the role so the learner can follow the sequence. Use these commands inside the loop:

   ```sh
   echo "Starting doer iteration..."
   cat refactor.md | (cd ../calculator && pi --no-session --tools read,edit,write,grep,find,ls -p)

   echo "Starting validation..."
   cat validate.md success.md | (cd ../calculator && pi --no-session --tools read,grep,find,ls,bash -p)
   ```

The completed `factory/run.sh` loops until the learner stops it: Bash invokes the doer, invokes the validator, then pauses for Enter and human validation before the next validation loop.

## Advanced: substitute another agent

Pi is the default doer and validator. Advanced users may replace either subshell with another CLI harness, but the doer must receive the prompt and criteria, run from `calculator/`, and only edit the kata files. The validator must receive the criteria, run from `calculator/`, inspect the kata and run validation commands, but not edit files. Its authentication, sandboxing, and tool restrictions are your responsibility; do not assume another harness supports Pi's flags or restrictions.

## Checks

From the repository root:

```sh
./factory/run.sh
```

After each pause, read the validation report. Verify manually that the console announces the doer and validator in order, the validator reports every success criterion, neither agent has more access than its role requires, and the loop waits for Enter before the next turn.

## Pressure test

The validator can identify a failure, but its verdict is only terminal text. A human must still decide whether to retry a refactoring or ask the doer to repair it. The next lesson saves the report and lets Bash route failed verdicts to a repair turn.
