# Route failed reviews to repair

Use the reviewer's verdict to send failed work to a repair turn.

## Key concept

The repeated factory already has a doer and a reviewer. This iteration makes the reviewer's structured verdict operational. Bash saves the review report, then uses the previous report to select the next doer prompt: normal refactoring after a pass, or focused repair after a failure.

Bash does not judge the code. It routes the reviewer's evidence. The doer still changes code; the reviewer still validates it against `success.md`.

## Decision flow

Show this Mermaid diagram when introducing the iteration:

```mermaid
flowchart TD
    Start([Start / press Enter]) --> Previous{Previous report?}
    Previous -- Missing or PASS --> Refactor[refactor.md\nDoer]
    Previous -- FAIL --> Repair[repair.md\nDoer]
    Refactor --> Reviewer[review.md + success.md\nReviewer]
    Repair --> Reviewer
    Reviewer --> Save[Save review-report.md]
    Save --> Pause[Pause for learner]
    Pause --> Start

    classDef start fill:#fef3c7,stroke:#d97706,color:#78350f,stroke-width:2px
    classDef decision fill:#ede9fe,stroke:#7c3aed,color:#3b0764,stroke-width:2px
    classDef doer fill:#dbeafe,stroke:#2563eb,color:#172554,stroke-width:2px
    classDef repair fill:#ffedd5,stroke:#ea580c,color:#7c2d12,stroke-width:2px
    classDef reviewer fill:#dcfce7,stroke:#16a34a,color:#14532d,stroke-width:2px
    classDef save fill:#cffafe,stroke:#0891b2,color:#164e63,stroke-width:2px
    classDef pause fill:#fce7f3,stroke:#db2777,color:#831843,stroke-width:2px
    class Start start
    class Previous decision
    class Refactor doer
    class Repair repair
    class Reviewer reviewer
    class Save save
    class Pause pause
```

## Implementation order

Keep `factory/refactor.md`, `factory/review.md`, `factory/success.md`, and the repeated validation loop from the previous iteration. Teach and build this iteration in this order. Complete each small step before moving to the next one:

1. **Write the repair prompt.** Create `factory/repair.md`. Tell the repair doer to read `../factory/success.md` and `../factory/review-report.md`, then make the smallest correction that addresses the failed criteria. It must edit files directly, not run tests, npm, or shell commands, and keep its response concise. `repair.md` references those documents; Bash need only pipe `repair.md` to Pi.
2. **Save the reviewer output.** Update the reviewer command so Bash displays its report and saves the same output to `factory/review-report.md`. Keep the role announcement immediately before Pi:

   ```sh
   echo "Starting review..."
   cat review.md success.md | (cd ../calculator && pi --no-session --tools read,grep,find,ls,bash -p) | tee review-report.md
   ```

   `review-report.md` belongs to Bash, not the reviewer. The reviewer still has no `edit` or `write` tool.
3. **Route the next doer turn.** At the start of each loop iteration, inspect the previous report. A missing report or an exact `VERDICT: PASS` selects normal refactoring. An exact `VERDICT: FAIL` selects repair. Announce the selected role before each Pi call:

   ```sh
   if [ ! -f review-report.md ] || grep -qx 'VERDICT: PASS' review-report.md; then
     echo "Starting doer iteration..."
     cat refactor.md | (cd ../calculator && pi --no-session --tools read,edit,write,grep,find,ls -p)
   elif grep -qx 'VERDICT: FAIL' review-report.md; then
     echo "Starting repair iteration..."
     cat repair.md | (cd ../calculator && pi --no-session --tools read,edit,write,grep,find,ls -p)
   else
     echo "Review report has no valid verdict; stopping for human review." >&2
     exit 1
   fi
   ```

The completed `factory/run.sh` retains its loop and learner pause. Every iteration announces the selected doer role, invokes it once, announces the reviewer, saves the review report, and pauses. A failed review becomes the next iteration's repair input. A passed review returns to normal refactoring.

## Advanced: substitute another agent

Pi is the default doer and reviewer. Advanced users may replace either subshell with another CLI harness, but the doer must run from `calculator/` and only edit the kata files. The reviewer must run from `calculator/`, inspect the kata, and run validation commands without editing files. Its authentication, sandboxing, and tool restrictions are your responsibility; do not assume another harness supports Pi's flags or restrictions.

## Checks

From the repository root:

```sh
./factory/run.sh
```

Verify manually that:

- the first iteration uses `refactor.md` because no report exists;
- Bash announces the doer, repairer, or reviewer before every Pi invocation;
- the reviewer output appears in the terminal and is saved in `factory/review-report.md`;
- a `VERDICT: FAIL` sends the next turn to `repair.md` with the previous report available to it;
- a `VERDICT: PASS` sends the next turn to `refactor.md`; and
- an absent or malformed verdict stops the script rather than guessing.

## Pressure test

The factory now reacts to every review, but one broad reviewer still decides everything at once. It cannot distinguish focused checks from broad ones, explain why a refactoring was chosen, or safely divide independent work. Later iterations will add only the next piece needed to relieve those pressures.
