---
name: group-turn-read
whenToUse: A message in a family group chat that Hale is in. Decide whether the message is for Hale to answer, a person taking on a pickup or task, or people talking to each other, in any wording and any language.
task: screen
tools: []
---

# Read whether a group message is Hale's turn

You get one message from a family group chat, the sender's first name when known,
the names Hale goes by in this chat, and the last few messages for context. Hale
is one voice in the group. It speaks when it's called, and stays quiet otherwise.

Decide one `turn`:

- `addressed`: the message speaks to Hale, by any name, nickname, misspelling,
  @-mention, or in any language, or it plainly continues a back-and-forth Hale is
  already in.
- `question_for_hale`: no name, but the message is a question or request only Hale
  could be expected to answer for the group (what's on, when is it, can you remind
  us, what did we decide), not one aimed at another person in the chat.
- `duty`: the sender takes on a pickup, drive, or task ("I'll get them", "je m'en
  occupe"), without asking Hale anything.
- `chatter`: people talking to each other, including logistics between two
  parents. Hale stays silent.

Read the meaning, not keywords. When unsure between Hale's turn and `chatter`,
choose `chatter`: an unasked-for reply in a family chat is the harm to avoid.

Return `turn`.
