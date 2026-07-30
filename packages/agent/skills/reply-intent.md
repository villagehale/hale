---
name: reply-intent
whenToUse: Hale asked a parent one yes/no question by text ("want me to keep an eye on all of this for you?") and their free-form reply must be read as agreement, refusal, or neither — the determination a consent record is written from.
task: classify
tools: []
---

# Read a parent's reply to a yes/no question as consent, refusal, or neither

Hale asked ONE question by text and the parent answered in their own words. You
decide which of three things their answer was. This determination becomes a
CONSENT RECORD — a legal artifact about whether a family agreed to be contacted
unprompted. Treat it that way.

You receive:

- `question`: the exact question Hale asked.
- `reply`: the parent's reply, verbatim.

## Output contract

Return strict JSON matching this shape (via the forced `intent` tool):

```
{
  "intent": "assent" | "decline" | "ambiguous",
  "verbatim": string,     // the reply, copied back EXACTLY, character for character
  "rationale": string,    // one short phrase — what in the reply decided it
  "confidence": number    // 0–1
}
```

`verbatim` must be the `reply` you were given, unchanged — not trimmed, not
tidied, not translated, not summarised. It is copied into the consent record as
the parent's own words, and a caller checks it against the original: if it does
not match, the whole reading is discarded. Copy it exactly.

## The three answers

- **assent** — they said yes to THIS question. "Yes", "yep", "sure", "please
  do", "sounds good", "go ahead", "oui", "ok!", "that would be great", "yes
  please, I need all the help I can get".
- **decline** — they said no to THIS question. "No thanks", "not right now",
  "I'd rather not", "no", "nah we're good", "maybe later", "non".
- **ambiguous** — anything else. This is the DEFAULT, and it is not a failure
  state; it is the correct answer whenever the reply is not clearly one of the
  other two.

## What is NOT assent

This is the part that matters. A reply is ambiguous — never assent — when it is:

- a QUESTION back ("what would you be watching?", "how much does this cost?",
  "who are you?", "is this a real person?")
- CONVERSATION or a pleasantry ("thanks!", "ok", "cool", "got it", "hi", "👍" on
  its own, "that's neat")
- an answer to a DIFFERENT question, or more intake detail ("also we have a
  third, he's 7", "M5V 2T6", "her name is spelled Mya")
- CONDITIONAL or hedged ("maybe", "I guess?", "depends", "if it's free", "let me
  ask my husband")
- anything you had to reason more than one step to read as a yes.

"ok" and "thanks" in particular are acknowledgements that a message arrived, not
permission to text someone unprompted. Read them as ambiguous.

A reply can be BOTH a decline and a question ("no — what would you even
watch?"). If a clear refusal is present, that is a decline: a person who says no
should be believed the first time, even if they are also curious.

## Calibration

The two failure directions are NOT symmetric. Reading ambiguous as **assent**
manufactures consent that was never given and lets Hale text a family who never
agreed — that is the failure that must not happen. Reading assent as
**ambiguous** costs one extra clarifying question, which the parent can answer.
So: when you are unsure at all, answer `ambiguous`. Only answer `assent` when
the reply would read as a plain yes to any person who saw it.

Never produce non-JSON output.
