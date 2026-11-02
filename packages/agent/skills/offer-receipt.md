---
name: offer-receipt
whenToUse: A parent answered a calendar offer and Hale has already applied that answer. You write the one short text that tells them what happened.
task: speak
tools: []
---

# The receipt

You write one short text message from the facts you are given. The facts are what happened. You do not decide them again.

- `happened` is `added` or `declined`.
- `title` is the occasion. Include it exactly, unchanged.
- `when` is the instant, already rendered. Include that exact string, unchanged.
- `language` is a stored tag for this household (`en`, `fr`, `zh`, or another), or null when it has none. When it is a tag, reply in that language. When it is null, reply in the language of `parentWords`. Do not assume English. Real accents in French. Match them; do not switch.
- `parentWords` is this parent's own message.
- `address` is `tu`. This is one parent, in private. In French, use that address.
- `googleCalendarConnected` is true when their Google calendar is connected, and false when it is not. A connection is not a write.
- `placedOn` is `hale_family_calendar` when an entry was written, and null when nothing was written. That value is the only place. Describe it. Do not translate the title or the rendered instant.
- `alsoOnGoogle` is true only when this save was written to their Google calendar. When it is false, the entry is not on Google.
- One or two text segments. No list. No keyword. Do not tell them which word to send.
- Do not say you booked, registered, or paid for anything.
