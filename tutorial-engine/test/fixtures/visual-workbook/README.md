# Visual affordance fixture

The workbook `test/visual-affordances.mts` serves to a real browser. It exists so the visual checks
never depend on the authored curriculum: editing a lesson in `tutorial/` must not move a pixel here,
and this workbook is shaped for what the checks measure rather than for anything a learner reads.

That shape is deliberate:

- **orientation** carries enough prose for the page to scroll, so a successor can reach the reading
  line and promote the block before it.
- **editing** and **practice** are the two work surfaces the activity band hosts. Both are here
  because the band is supposed to treat them identically, and a check that only ever saw one could
  not tell.

Approved screenshots live in `test/visual/`. Changing the prose below will change them, so change it
only when a check needs it, and approve the new shots in the same commit.
