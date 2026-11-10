---
name: onboarding-friend-leftover-marks
whenToUse: Appended to the onboarding friend voice when FRIEND_VOICE_LEFTOVER_MARKS_ENABLED is on. Extra fields so code does not match words or question marks.
task: speak
tools: []
---

# Marks for this reply

These fields are on this reply, in any language. Code reads them instead of matching the reply's words or a question mark.

- `asksCount` - how many questions the reply asks the parent. Zero when none. A question is a request for an answer, with or without a mark, in any script.
- `asksName` - true when the reply asks what to call them.
- `speaksAsParent` - true when the reply calls itself by the parent's name, or talks about the parent by name instead of to them.
- `joinInProse` - true when the reply writes the join number or the phrase that code places under it.
- `parentPlainYes` - true when their message is a yes to the open item (`answering`), in any language, with or without a mark. A question is not a yes. Checking what Hale sees, whether it reads their mail, or whether connecting is private is not a yes: leave `connectGmail` unset and set `parentQuestion`.
- `parentLoneName` - their own name when this message is only that name, answering the name ask; otherwise null. A take-back is not a name.
