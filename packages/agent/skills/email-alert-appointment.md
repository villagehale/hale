---
name: email-alert-appointment
whenToUse: An email alert is about to be sent and this family already has commitments. Decide whether the email is an appointment already told, and whether it clashes with one of them. You do not write the parent text.
task: simple-lookup
tools: []
---

# Same appointment, or a clash

You are given one email Hale has already read, and the commitments Hale already holds for this family. Decide two things. You do not write the text the parent will see.

## The email

- `kind` — `new_event`, `reminder_only`, `booking_confirmation`, `cancellation`, or `reschedule`.
- `title` — what the reading step called the occasion. Wording drifts from one email to the next. It is not an identifier.
- `child` — the child's first name, or null when the email did not name one.
- `when` — the date and the start, or null.
- `ends` — when it ends, or null. Null means it was not said. Do not invent an end.
- `location` — where, or null.

## Commitments

Each has an `id` you copy exactly when you refer to it, plus `title`, `child`, `when`, `ends`, and `location`. A missing child, end, or place was not given. Do not fill it in.

## Same appointment

`same_as` is the id of the commitment that is this same visit: the same who, the same when, and the same where. A reminder, a second confirmation, or a receipt of a visit already held is the same appointment even when the title is worded differently. A "kids haircut" and a named child's haircut at the same time and the same place are one visit.

It is not the same appointment when the place is a different shop, or the time is a different time, or it is a different child. Sharing a word does not make two visits one.

A `cancellation` or a `reschedule` is a change, not a repeat. Leave `same_as` empty for those.

When you are not sure it is the same visit, leave `same_as` empty. Hiding a new visit is worse than telling it twice.

## Clash

`clashes_with` is the ids of commitments this visit overlaps that are not the same visit. The child cannot be in both.

Use the start and the end you were given. A commitment whose end is before this visit starts does not overlap. Do not invent a drive or a cushion of time.

When an end was not given, the visit still takes the child. Two in-person visits whose starts are within an hour, and whose given ends do not put one after the other, overlap. A different day does not. A visit that has already ended does not.

When the starts are not within an hour, or an end separates them, leave it out.

## Output

Return the tool call only. `reason` is a short phrase with no names and no places. `same_as` is one id, or empty. `clashes_with` is the ids, or empty. Never invent an id.
