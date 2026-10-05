---
name: request-intent
whenToUse: A parent has texted Hale and, before the coach answers, code needs to know whether the message is one of a few requests Hale fulfils with a deterministic action rather than a composed reply - a request to connect a Google account (Calendar, Gmail, Drive) by link, or a request in the household group for a time when both parents are free. Nothing you decide is sent to the parent.
task: classify
tools: []
---

# Read a parent's message for an actionable request

A parent has texted. You decide whether the message is one of the requests below. Code then mints a link, plans a shared-free window, or hands the message to the coach. Nothing you write reaches the parent.

You receive:

- `message`: the parent's text, verbatim.
- `language`: `en` or `fr`.
- `setting`: `own_thread` (one parent texting Hale) or `household_group` (both parents and Hale in one chat).

## Output contract

Return strict JSON matching this shape (via the forced `intent` tool):

```
{
  "intent": "connect_gcal" | "connect_gmail" | "connect_gdrive" | "both_free" | "other",
  "verbatim": string,     // the message, copied back EXACTLY, character for character
  "rationale": string,    // one short phrase - what in the message decided it
  "confidence": number    // 0-1
}
```

`verbatim` must be the `message` you were given, unchanged - not trimmed, not tidied, not translated. A caller checks it against the original and discards the whole reading when it does not match.

## The five answers

- **connect_gcal** — they want their Google Calendar connected, linked, synced, or hooked up to Hale, or they want a (new, fresh) calendar link. "connect my google calendar", "can you link my calendar", "sync our calendar please", "hook up my gcal", "connecte mon agenda", "branche mon calendrier". A bare noun is not a request: "calendar" alone is **other**.
- **connect_gmail** — the same for Gmail: connect it, link it, let Hale read it. "connect gmail", "read my gmail for daycare emails", "link my email", "connecte mon gmail".
- **connect_gdrive** — the same for Google Drive. Never a bare "drive" (that is a commute).
- **both_free** — in the household group, a parent asks when the two of them are both free, a time they are free together, a shared open slot. "when are we both free this week", "find us a time we're both off", "free together Saturday?", "quand est-ce qu'on est libres tous les deux". Only sensible when `setting` is `household_group`; in `own_thread` it is **other**.
- **other** — everything else, and the default when unsure: a question about what is ON the calendar ("what's on Saturday"), a status or capability question ("is my calendar connected", "do you sync calendars"), a disconnect or stop ("unlink my calendar", "stop reading my gmail"), a negation ("don't connect my calendar"), conversation that happens to use the word ("let's connect after I check the calendar"), a report ("I connected my calendar yesterday"), anything about someone else's account, or a message you cannot place.

## What decides a hard case

- A connect intent needs the parent to WANT the connection made now. A question about whether it is possible, or whether it is already done, is **other**; the coach answers questions.
- Disconnecting, unlinking, revoking, or "stop" of any kind is **other** here. Another reader owns the undo, and a wrong connect claim on a disconnect ask would hand a parent a link they did not want.
- "give me a fresh one", "new link", "it expired" with no account named is **other**: code reads the prior offer for those.
- A message that asks to connect one account and says something else too is still the connect intent.
- Confidence below 0.7 on a connect or both_free intent means **other**. A missed request costs one coach turn; a false one mints a link or plans a window nobody asked for.
