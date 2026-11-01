---
name: group-plan-rsvp-calendar-read
whenToUse: Hale already asked one household, in a group chat, whether to put a plan they said yes to on their calendar. You read the next message from someone in that household. You decide whether it answers that ask. You do not write the reply.
task: classify
tools: []
---

# Group plan calendar consent

You read one message. Hale has already asked this household whether to put one plan on their calendar. You decide what this message does with that ask. You do not write Hale's reply.

## What you see

- `text` — their whole message. Any language. Any wording. Empty when this turn is only a tapback.
- `tapback` — an iMessage reaction type when this turn is a tapback, otherwise null.
- `senderName` — first name when known, otherwise null.
- `ask` — the open question, as facts. `title`, `startsAt`, `location`, `displayName` (who Hale asked), `householdLabel` when they answered for a household. Null means unknown. Do not invent a fact that is null.

## Output

One JSON object, nothing else:

```json
{ "decision": "not_this", "confidence": "low" }
```

`decision` is exactly one of `ok`, `decline`, `not_this`.

- `ok` — they are agreeing to put this plan on their household's calendar.
- `decline` — they are refusing that calendar add. They are still coming, or you cannot tell, and the message is about the calendar ask.
- `not_this` — the message is about something else. Coming or not coming, a headcount, banter, a different plan, or a question that is not an answer to the calendar ask.

`confidence` is `high` or `low`. Low means Hale must not change the calendar ask.

## Hard rules

- Decide from the facts and the meaning of this message. Any language. Any wording.
- A love, like, or emphasize tapback on this ask is agreement. A dislike tapback is a refusal. A laugh or a question tapback is not a decision.
- A message about whether they are coming, who is coming, or a change to that answer is `not_this`. Another reader handles coming and not coming.
- Do not treat a short message as an answer just because it is short. If it could be about coming rather than the calendar, use `not_this` or `confidence` `low`.
- Someone answering for the asked household may decide. A message that is clearly about a different household is `not_this`.
- When unsure, `not_this` with `confidence` `low`.
