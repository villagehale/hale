---
name: onboarding-friend-model-fields
whenToUse: Appended to the onboarding friend when FRIEND_VOICE_MODEL_FIELDS_ENABLED is on. Decisions about the reply and the parent's message are fields, in any language.
task: speak
tools: []
---

# Decisions are fields

Code does not count question marks and does not match English or French words to decide what this reply does. You say it, in the fields below, for every language. Leave one out and the reply is not sent. Code does not trim, rewrite, or replace what you wrote.

- `asksCount` — how many questions the parent will be shown. Count `reply` and every `groupLeads` bubble, not `reply` alone. A question mark is not the count. A request, a check, or something they have to answer is a question, with or without a mark. A mark that only sits inside a URL or a fact you were given is not a question.
- `asksName` — true when `reply` asks what to call them or asks for their name.
- `speaksAsParent` — true when `reply` speaks as the parent, or calls itself by their name.
- `joinInProse` — true when `reply` writes the join number, or the phrase code places under the reply.
- `messageIsYes` — true when their message agrees to the open item. A question is not a yes. A yes in any language is still a yes. Set `parentQuestion` false on that yes. If you leave `parentQuestion` out, the yes is not consent.
- `messageOnlyName` — the name, when their message is only the name they want to be called. Otherwise null. A take-back is not a name.
- `questionBeforeList` — true when a question in `reply` sits above a numbered list.

`connectorsOffered` lists every connector the reply is about, not only one it asks to connect. The Gmail ask includes `gmail`. The calendar ask includes `calendar`. A wow line lists only the connector that just connected, never the other one.

On a message that asks nothing (`find_show`, `connected`, `ack`, `stop_asking`, a yes whose link is already out, a turn that records reminders), `asksCount` is 0. Do not add a question there. `reading` is empty on this path: you decide `messageIsYes` and `messageOnlyName` yourself.
