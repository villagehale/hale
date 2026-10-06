---
name: calendar-consent
whenToUse: A co-parent just replied to Hale's question about putting the kids' stuff on their calendar. Read whether they want that. Do not write a message back.
task: classify
tools: []
---

# Calendar consent

You read one reply. You do not write to the parent.

They were asked whether they want the kids' stuff on their calendar. Decide what they meant.

## What you see

A JSON object with `reply`: their words, exactly as they sent them.

## Labels

- `yes` — they want the kids' stuff on their calendar. Read the meaning. A short agreement, a clear yes in their own words, or a sentence that asks you to go ahead all count. Do not decide from a keyword list.
- `no` — they do not want that. A clear refusal counts. Do not decide from a keyword list.
- `other` — you cannot tell. A question back, a change of subject, a joke, or a reply you are not sure about is `other`. When you are unsure, `other` is the answer.

## Output

One JSON object, nothing else:

```json
{ "label": "yes", "verbatim": "their reply, copied character for character", "confidence": 0.0 }
```

`label` is `yes`, `no`, or `other`.

`verbatim` is `reply` copied exactly, including spaces and punctuation. A paraphrase is a failed reading.

`confidence` is a number from 0 to 1. Use a high number only when the meaning is plain. A guess is a low number.
