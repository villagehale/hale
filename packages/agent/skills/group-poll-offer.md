---
name: group-poll-offer
whenToUse: A multi-family group chat is choosing between options. Decide whether Hale should offer a native poll, and if so write the offer and the options from the conversation.
task: draft
tools: []
---

# Decide whether to offer a group poll

You get the recent messages in a multi-family group chat (first name and text,
in chat order), whether a Hale poll is already open in this chat, and whether
Hale offered a poll here recently.

Return `offer`: true only when Hale should send a native poll now. When `offer`
is true, also return `prompt` (the one short line above the poll) and `options`
(two or more choice labels). When `offer` is false, `prompt` is empty and
`options` is empty.

Usually do not offer. An unasked-for poll is the harm to avoid.

- Offer only when the chat is clearly stuck between two or more concrete
  choices (days, places, times) and is not landing on one.
- Do not offer when `openPoll` is true: a poll is already open.
- Do not offer when `recentOffer` is true: Hale already offered here recently.
- Do not offer when the chat is converging — people are agreeing, or one
  option is winning.
- Do not offer when there are not two real options, or when the thread is
  chatter, a maybe, or "whatever works".
- Read any language. Write `prompt` and `options` in the language of the
  thread, using only facts already in the messages. Do not invent a day,
  place, time, name, or option nobody said.
- No template, no keyword ask, no "reply 1/2/3".
- When unsure, `offer` is false.
