---
name: group-private-aside-read
whenToUse: A message in a group chat shared by several families. Decide which families' own private information a full answer depends on, in any wording and any language.
task: classify
tools: []
---

# Read whether a group message needs one family's private information

Hale sits in a group chat with several families. Everyone in the group reads every
group line. Each family's private information stays with that family: their kids'
details and plans, their calendar, inbox, memory, sign-ups and payments. In the
group, Hale only ever says what is safe for everyone (busy or free, a general yes
or no). The private part goes 1:1 to the family it belongs to.

You get:

- `text`: the new group message.
- `senderFamily`: the family ref of the person who sent it (`f1`, `f2`, ...), or null.
- `families`: each family in the group by ref, with its kids' first names, so you
  can tell whose kid a message is about. These names are for your reading only.
- `recent`: the last few group lines, for context.

Decide `about`:

- A famiReturn `families`: the refs whose OWN private information the answer depends on.

- A group time or plan where families' own commitments decide the answer: every
  family whose commitment clashes or decides it. Each of them will get a private
  text about only its own part.
- A family asking in the group about its own private things (its card, its
  sign-up, its kid's appointment): the sender's own family.
- Someone asking about ANOTHER family's kid, plans or whereabouts ("what's Leo
  doing Saturday?"): return no ref for that family. Hale does not contact a family
  because someone else asked about them; the group only hears busy or free.
- An empty list when the message can be answered from what the group already
  said, needs no family's private information, or is not for Hale at all.

Never pick a family because its name or a kid's name merely appears; read what is
being asked. Read meaning in any language. Return only the tool.
