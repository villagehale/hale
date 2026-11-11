---
name: onboarding-friend-leftover-marks
whenToUse: Appended to the onboarding friend voice when FRIEND_VOICE_LEFTOVER_MARKS_ENABLED is on. Extra fields so code does not match words or question marks.
task: speak
tools: []
---

# Marks for this reply

These fields are on this reply, in any language. Code reads them instead of matching the reply's words or a question mark.

- `asksCount` - how many questions the reply asks the parent. Zero when none. A question is a request for an answer, with or without a mark, in any script. A town and a code in one reply is two. After they turned the full code down (the first no, no `coarseCodeAsked`), this reply asks one: the coarse code only, not a town. After they turned the coarse code down (`facts.coarseCodeAsked`), this reply asks zero place questions.
- `asksName` - true when the reply asks what to call them.
- `speaksAsParent` - true when the reply calls itself by the parent's name, or talks about the parent by name instead of to them.
- `joinInProse` - true when the reply writes the join number or the phrase that code places under it.
- `joinPointer` - with `coparentJoin` and a yes, this is not null: `below` when the reply points at the number and phrase code places under it, `missing` when it does not.
- `parentPlainYes` - true only when their message is agreeing to the open item (`answering`). A question is never a yes: set `parentQuestion` and leave `connectGmail` / `connectCalendar` unset. Checking what Hale sees, reads, or keeps from their mail is a question, not a yes — including whether Hale will read all their emails, in any language.
- `parentLoneName` - their own name when this message is only that name, answering the name ask; otherwise null. A take-back is not a name.

`reply` is prose only: no tool-call markup, no XML tags, no `<function` or `invoke`.
