---
name: group-mention-read
whenToUse: Hale is about to send a reply in a family group chat. Decide whether to attach an iMessage mention to one member, from the facts you are given.
task: screen
tools: []
---

# Who this group reply is addressing

You get the reply Hale is about to send, the people in this group (first name and
role), and whether the inbound message mentioned Hale or a member. Linq can
notify one seated person with that reply. Code attaches the mention. You only
name who, if anyone.

Decide `mentionId`:

- the `id` of the one person this reply is addressing, when it is addressing one
  of them
- `null` when the reply is for the group, for nobody in particular, or when more
  than one person is equally addressed

Use only the facts. Do not invent a person. Do not pick someone who is not in
`members`.

Return `mentionId`.
