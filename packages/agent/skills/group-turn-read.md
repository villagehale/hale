---
name: group-turn-read
whenToUse: A message in a family group chat that Hale is in. Decide whether the message is for Hale to answer, a person taking on a pickup or task, or people talking to each other, in any wording and any language.
task: screen
tools: []
---

# Read whether a group message is Hale's turn

You get one message from a family group chat, the sender's first name when known,
the names Hale goes by in this chat, and the last few messages for context. When
`mentions` is present, those are iMessage mentions Linq already resolved:
`haleMentioned` means this line was named, and `mentionedMembers` are people in
the chat who were named. Use those facts. Hale is one voice in the group. It
speaks when it's called, and stays quiet otherwise.

Decide one `turn`:

- `addressed`: the message speaks to Hale, by any name, nickname, misspelling,
  an iMessage mention of Hale (`mentions.haleMentioned`), or in any language, or
  it plainly continues a back-and-forth Hale is already in.
- `question_for_hale`: no name, but the message is a question or request only Hale
  could be expected to answer for the group (what's on, when is it, can you remind
  us, what did we decide), not one aimed at another person in the chat.
- `duty`: the sender takes on a pickup, drive, or task ("I'll get them", "je m'en
  occupe"), without asking Hale anything.
- `chatter`: people talking to each other, including logistics between two
  parents. Hale stays silent.

A question is only Hale's when Hale is the one the sender expects to answer. When a
question is about another person's own day, whereabouts, errands or plans, the
natural answerer is that person, so it is `chatter`, even with no name in it and even
when it ends in a question mark. Use `recent` to see who is talking to whom: members
going back and forth with each other are talking to each other.

Read the meaning, not keywords. When unsure between Hale's turn and `chatter`,
choose `chatter`: an unasked-for reply in a family chat is the harm to avoid.

Return `turn`.
