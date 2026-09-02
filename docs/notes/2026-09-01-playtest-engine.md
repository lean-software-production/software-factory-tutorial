# Play-test findings: engine

Transcript date: 2026-09-01 (the Ensembleworks server's date boundary).

## Accepted steps make the editor read-only

After a step was accepted, Aldric could see but not edit its text. This prevents a learner from
correcting or experimenting with an accepted artefact.

Expected: an accepted step's artefact remains editable, or the engine offers an explicit follow-up
editing action with a clear state transition.

Evidence: 18:22:23–18:22:51.

Need Aldric's session log for this interval to identify the accepted event, the editor target, and
whether the lock is intentional lifecycle behaviour or an editor-state defect.

## Copying supplied commands has no confirmation

Copying the generated harness gave no visible indication that the command reached the clipboard.

Expected: immediately acknowledge a successful copy (for example, a brief “Copied” label) and make
failure visible.

Evidence: 18:23:04–18:23:12.

## Scroll state and progression navigation are unstable

Typing caused the page to bounce; manual scrolling could leave the learner unable to find the
current content; and newly revealed steps often did not come into view. The scroll-driven widening
of the editor and terminal was confusing and appears to add fragility. A later horizontal overflow
was another symptom.

Expected: typing and manual scrolling do not alter, hide, or displace the active task. On
progression, keep the learner's position if the next step is visible; otherwise bring that step into
view. Remove the scroll-driven resizing until this baseline is reliable.

Evidence: 16:28:40–16:30:52; 17:31:05–17:31:58; 17:43:29; 17:57:53–17:57:54;
18:02:35; 18:08:29–18:10:04; 18:36:09–18:36:18.

Need Aldric's browser/session log, viewport dimensions, and the event sequence around each listed
timestamp. The transcript shows symptoms but cannot distinguish scroll restoration, layout
measurement, step-progression, and the experimental resizing paths.
