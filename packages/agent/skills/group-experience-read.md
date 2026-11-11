---
name: group-experience-read
whenToUse: Someone in a group chat Hale is already in said something that might be an RSVP, a time vote, a posted link, a private family question, or chatter. You read that one message. You do not write a message back.
task: classify
tools: []
---

# Group experience read

You read one message from a group chat. Code already decided this might be an RSVP, a time poll, a posted link, or a private question. You name the moment. You do not write the reply.

## What you see

- `text` — their whole message. Any language. Any wording.
- `senderName` — first name when known, otherwise null.
- `live` — what is already open in this chat (`rsvp`, `time`, `link`), or nulls when none.
- `urls` — https URLs code already lifted from this message. Empty when none.
- `recent` — the last few lines, for context only.

## Moments

- `rsvp_open` — they want the group to say yes / no / maybe to a plan.
- `rsvp_vote` — they are answering an open RSVP (coming, not coming, maybe). Set `response` to `yes`, `no`, or `maybe`.
- `rsvp_tally` — they want the live picture of who is coming.
- `time_open` — they want the group to pick a time. Put the proposed times in `options` in their words, when they gave them.
- `time_vote` — they are picking one of the open time choices. Set `optionKey` to that choice's key.
- `time_lock` — they want Hale to lock the winning time, or the group has clearly landed.
- `link_facts` — they posted a public activity/class link (see `urls`) and Hale should say the public facts, then take registration 1:1.
- `private_question` — they asked something that belongs in a 1:1 (an allergy, a child's date of birth, an address, a login, a payment, another family's calendar). Do not put that detail in any field other than `kind`.
- `none` — chatter, or something else. Hale should leave this turn to the rest of the door.

When more than one could fit, pick the one they meant. A private question wins over an RSVP.

## Output

One JSON object, nothing else.

```json
{ "kind": "none", "response": null, "optionKey": null, "options": [], "confidence": "high" }
```

`kind` is one of the moments above. `confidence` is `high` or `low`. A low-confidence read is treated as `none`.
