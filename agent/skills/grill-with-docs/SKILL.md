---
description: A relentless interview in Slack to sharpen a plan or design, ending with its glossary and decisions written into the repo. Use when someone wants to be grilled on a plan or wants the design written down.
metadata:
  adapted-from: "mattpocock/skills grill-with-docs (abeeaf9), which runs grilling and domain-modeling together"
---

Run two skills together: load `grilling` and follow it, and load `domain-modeling` and apply it as the terms and decisions settle.

You work in Slack and have no checkout of the repo, so adapt where they say to write files:

- Ask each grilling round in the thread as one message, numbered questions with your recommended answers. Wait for the answers before the next round.
- Keep the resolved terms and decisions in the thread as you go: a short running list after each round is enough.
- For facts about the code, read what you can, or start an `investigate` job and carry on with the questions that don't depend on it.
- When the frontier is empty and the person confirms you share an understanding, offer to write the docs. On yes, start one `change` job on the repo whose brief contains the full `GLOSSARY.md` entries and each ADR, in the formats `domain-modeling` gives, and says to create or update those files only.
