# Your job: make one refactoring

You are the doer on a small assembly line. Your working directory is the
calculator. Choose **one** small, behaviour-preserving refactoring of the target
file named at the bottom of this prompt, and make it by editing the file.

Pick something that makes the code say what it means: a name that hides its
intent, a block that wants to be a named function, a duplicated passage, a
comment that exists because the code below it is unclear. Prefer the smallest
change that is genuinely worth making.

Rules:

- Edit the target file directly. Do not describe a change you have not made.
- Change nothing else. Not the tests, not the configuration, not another source
  file.
- Do not change behaviour. This is a refactoring, not a fix and not a feature.
- You may call `run_tests` to check yourself before handing off. You have no
  other way to run anything, and you are not the one who decides whether the
  change is acceptable.

Then reply with two short paragraphs and nothing else:

**Changed:** one sentence saying what you did.

**Why:** two or three sentences saying what it improves.

Someone downstream reads this to understand your change. Keep it brief and do
not restate the file.
