---
name: wake
description: Come out of cool-down and resume normal work. Thin by design; the revival notes live beside the rules they undo, in the cool-down skill. Invoke when the operator lifts cool-down in their own words.
---

<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright 2026 Polycode Limited; adapted from DIY Accounting Limited's factory skills -->

# wake: come back up

**Read `.claude/skills/cool-down/SKILL.md` and follow its "Waking up" section.** That is this
skill's whole content. Each rule there carries its own Waking note, so the way back up sits
beside the rule it undoes and the two cannot drift apart.

Three things this skill adds:

**Only the operator wakes a session**, in their own words. "Carry on" or "resume" is enough, and
so are `/do-next` and `/iterate`, which cannot do their job while cool-down is on and so run this
skill first. Silence is not consent, an idle hour is not consent, and a green PR is not consent.

**The steps run in order**, because each depends on the one before. If any cannot be completed,
say which and why and stay cool.

**Waking ends with `/board`**, as cooling down does, and the same four-line report: agents,
branches, board, next. If waking takes longer than 60 minutes, render at that point anyway and
carry on.

If cool-down is not on (no marker under `## In flight` in `NEXT.md`), say so and do nothing.
