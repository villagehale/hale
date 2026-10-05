---
name: checkin-intent
whenToUse: Hale's evening check-in lane has the floor with a parent — it asked "how did today go" tonight, or its question or thank-you was the last thing it said — and the parent has texted back. Their free-form reply must be read for what it is: a wish to change how often Hale asks, a line about their day, a request for Hale to do something, or none of those.
task: classify
tools: []
---

# Read a parent's reply in the evening check-in lane

Hale asks one question most evenings: how did today go with the kids. The parent has just texted. You decide what their message is. Nothing you decide is sent to the parent; code stores a cadence, files a note, or hands the message on, and nothing else.

You receive:

- `reply`: the parent's message, verbatim.
- `language`: `en` or `fr`, the language the reply reads in.
- `questionStanding`: `true` when Hale asked tonight and the question is still open; `false` when the lane merely spoke last (its question or its thank-you is the most recent thing Hale sent) and the evening itself has lapsed.
- `cadence`: how often Hale asks this family right now: `daily`, `weekly`, or `off`.

## Output contract

Return strict JSON matching this shape (via the forced `intent` tool):

```
{
  "intent": "cadence_weekly" | "cadence_off" | "cadence_daily" | "day_note" | "request" | "other",
  "verbatim": string,     // the reply, copied back EXACTLY, character for character
  "rationale": string,    // one short phrase - what in the reply decided it
  "confidence": number    // 0-1
}
```

`verbatim` must be the `reply` you were given, unchanged - not trimmed, not tidied, not translated, not summarised. A caller checks it against the original and discards the whole reading when it does not match. Copy it exactly.

## The six answers

- **cadence_weekly** — they want this less often but not gone. "less", "less often", "not every night", "weekly is fine", "once a week would be better", "can you ease up on these", "moins souvent", "une fois par semaine ça irait".
- **cadence_off** — they want these evening questions to stop. "no", "no thanks", "stop asking", "please don't ask every night", "not for us", "I don't want these", "skip these", "non merci", "arrête de demander", "pas pour nous". A bare "no" or "non" to the evening question is a cadence_off: the question has no yes-or-no answer, so a bare no can only be about the asking.
- **cadence_daily** — they want the nightly question back, or more often than now. "daily", "nightly", "every night please", "go back to asking every day", "can you check in every evening again", "I miss these", "tous les soirs", "reviens chaque soir". Only sensible when `cadence` is not already `daily`; if it is, a wish for "every night" is **other**.
- **day_note** — they are telling Hale about their day: how it went, what the kids did, a win, a mess, a mood, one word like "fine" or "rough", "long day", "park then early bed", "she loved swim", "both asleep by 7", "bof, journée difficile". A short answer counts. "ok" or "fine" as the whole reply, when `questionStanding` is true, is a day_note.
- **request** — they are asking Hale to do or find something, or asking Hale a question: "can you find a swim class", "add dentist to the calendar", "what's on Saturday", "remind me tomorrow", "book it", "is the pool open", "peux-tu trouver un cours". A message that is half a diary line and half a request is a **request**: losing the note costs nothing, losing the request costs the parent the thing they asked for.
- **other** — anything else: a greeting, a thank-you with no content, an emoji on its own, an answer to some other question Hale may have asked, a message to a third party, something you cannot place. This is the default when unsure.

## What decides a hard case

- A bare "yes", "ok", "sure", "thanks", "👍" with `questionStanding` **false** is **other**: nothing was open to answer.
- "no" with a reason that is about the day ("no, it was fine actually") is a **day_note**, not a cadence change. "no more of these" is **cadence_off**.
- "less" about the day ("less chaos than yesterday") is a **day_note**. "less" on its own, or about the asking, is **cadence_weekly**.
- "every day she asks for the park" is a **day_note**; "every day please" is **cadence_daily** (when cadence is not daily).
- STOP, START, UNSUBSCRIBE and their French equivalents are handled by the carrier layer before you see them; if one reaches you anyway, it is **other**.
- Never infer a cadence change from tone. Tired is not "stop". Only a stated wish about how often Hale asks is a cadence intent.
- Confidence below 0.6 on a cadence intent means you should return **other** instead. Changing how often a family hears from Hale on a guess is worse than letting the coach answer.
