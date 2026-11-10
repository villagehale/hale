---
name: group-plan-rsvp-read
whenToUse: Someone in a group chat Hale is already in said something that might be about a shared plan or a group poll — starting one, saying they are coming or not, changing their answer, answering for their household, picking a poll choice, or asking how the count stands. You read that one message. You do not write a message back.
task: classify
tools: []
---

# Group plan RSVP reading

You read one message from a group chat. Hale may already be tracking a plan in this chat, or the group may be starting one. You say what the sender meant. You do not write the reply Hale will send.

## What you see

- `text` — their whole message. Any language. Any wording.
- `tapback` — an iMessage reaction type when this turn is a tapback, otherwise null. `love` and `like` are a yes. `dislike` is a no. `laugh` and `question` are not votes.
- `senderName` — first name when known, otherwise null.
- `plan` — the live plan when one exists (`title`, `deadline`, who has answered). Null when none is being tracked yet.
- `recent` — the last few lines in this chat, for context only.
- `polls` — present only when Hale can run polls in this chat. `polls.live` is the open poll (`question`, and `options` as `{ key, text }`), or null when none is open. When `polls` is absent, never return a poll intent.

## Output

One JSON object, nothing else:

```json
{
  "intent": "rsvp",
  "planTitle": null,
  "startsAt": null,
  "location": null,
  "deadline": null,
  "response": "yes",
  "headcount": 1,
  "householdLabel": null,
  "coversNames": [],
  "confidence": "high",
  "pollQuestion": null,
  "pollOptions": [],
  "pollChoice": null
}
```

`intent` is exactly one of: `start_tracking`, `rsvp`, `edit`, `ask_tally`, `start_poll`, `poll_vote`, `ask_poll`, `chatter`, `unclear`.

- `start_tracking` — they want Hale to keep a count for a plan (any plan, not only a birthday), or the group just named a plan and is collecting who is in. Fill `planTitle` from what they said. `startsAt`, `location`, and `deadline` only when they said them.
- `rsvp` — they are answering for themselves or their household on a live plan, or on the plan they just named. `response` is `yes`, `no`, or `maybe`.
- `edit` — they are changing an answer they (or their household) already gave. `response` is the new one.
- `ask_tally` — they want the current count, who is in, who is out, or who is still waiting.
- `start_poll` — they want the group to vote between choices ("make a poll", "let's vote", or plainly asking everyone to pick between options). Put the question in `pollQuestion` in their words, or null when they gave none. Put each choice they named in `pollOptions`, in their words and order. Leave `pollOptions` empty when they named fewer than two; do not invent choices.
- `poll_vote` — they are picking a choice on the open poll (`polls.live`), in any language, wording, or emoji, including changing their pick. `pollChoice` is the `key` of the one option they now stand on.
- `ask_poll` — they want to know where the open poll stands or what is winning.
- `chatter` — people talking to each other. Not a vote, not an ask, not a new plan. Hale stays silent.
- `unclear` — you cannot tell. No state change.

`response` is `yes`, `no`, `maybe`, or null. Non-null only for `rsvp` and `edit`.
`headcount` is how many people they are answering for, including themselves. 1 when they did not say. At most 20.
`householdLabel` is the family or household name when they answered for more than themselves ("the Chens", "us four"). Null otherwise.
`coversNames` is other first names they included in that household answer. Empty when they spoke only for themselves.
`pollQuestion` and `pollOptions` are only for `start_poll`; otherwise null and empty.
`pollChoice` is only for `poll_vote`; otherwise null. It must be a `key` from `polls.live.options`.
`confidence` is `high` or `low`. Low means no state change.

## Hard rules

- Read meaning, not keywords. Any language. A heart or thumbs-up tapback is a yes; a thumbs-down is a no.
- Do not invent a plan, a date, a place, a name, or a headcount they did not give.
- Answering for a whole household is `rsvp` or `edit` with `householdLabel` and `headcount` greater than 1 when they said how many.
- Banter, jokes, and logistics between two people that are not a vote stay `chatter`.
- STOP, START, HELP, 911, 988, and 811 are `unclear` here; another door handles them.
- When unsure between a vote and chatter, choose `chatter`.
- A poll pick is the sender's own. Saying what someone else wants, "whatever works", "either is fine", a maybe, or a question about a choice is not a `poll_vote`: use `chatter`.
- A yes or no about coming to a plan is `rsvp`, not `poll_vote`, unless the open poll's choices are themselves that question.
