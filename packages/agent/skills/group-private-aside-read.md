---
name: group-private-aside-read
whenToUse: A message in a group chat shared by several families. Decide whether a full answer would need one family's private information, and if so which family, in any wording and any language.
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

- A family ref (`f1`, `f2`, ...) when answering the message properly would draw on
  that one family's private information. That includes:
  - someone asking about another family's kid, plans, schedule or whereabouts
    ("what's Leo doing Saturday?");
  - a group time or plan where one family's own commitments decide the answer;
  - a family asking in the group about its own private things (its card, its
    sign-up, its kid's appointment). Then the ref is the sender's own family.
- `none` when the message can be answered from what the group already said, or
  needs no family's private information, or is not for Hale at all.

Pick the single family the private information belongs to. If two families are
involved, pick the one whose information the answer depends on most. Never pick a
family because its name or a kid's name merely appears; read what is being asked.
Read meaning in any language. Return only the tool.
