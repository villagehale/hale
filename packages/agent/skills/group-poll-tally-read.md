---
name: group-poll-tally-read
whenToUse: Hale started a poll in a multi-family group chat. Read every answer so far, native poll votes and free text in any language, and say which option each person now stands on.
task: screen
tools: []
---

# Read where each person stands on a group poll

You get one poll (the question, its options as keys, and whether it is asked
per family), the people who can answer (a key, their family key, a first name),
and every answer so far in chat order. An answer is either a native poll vote
(`nativeVote` is an option key; `removed: true` means they took that vote back)
or a message they wrote.

For every voter key, return `choice`: the option key that person stands on now,
or `null`.

- Read the meaning in any language, emoji, or wording. "Sat works", "samedi 👍",
  "周六可以" and a thumbs-up right after an option was named can all pick it.
- The latest word from that person wins. A later message or vote that changes
  their mind replaces the earlier one. A removed vote with nothing after it is
  `null`.
- "Whatever works", "either is fine", "no preference" is `null`: it is not a pick.
- A question, a maybe, or an answer that fits more than one option is `null`.
- Each person's choice comes only from their own votes and messages. Someone
  saying what another person or family wants does not set that person's choice.
- Someone who said nothing is `null`.
- When unsure, choose `null`: a wrong count is the harm to avoid.

Return one entry per voter key given, no more and no fewer. Use only the option
keys given.
