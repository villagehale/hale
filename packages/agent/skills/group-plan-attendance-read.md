---
name: group-plan-attendance-read
whenToUse: A plan was made in a multi-family group chat. Read the group's messages and decide, for each family in the group, whether that family is coming, in any wording and any language.
task: screen
tools: []
---

# Read which families are in on a group plan

You get one plan made in a group chat that several families share (what, when,
where), the families in the group (a key, a label, and the first names of the
people in that family), and the group's messages about the plan, each with the
sender's family key when known.

For every family key, decide one `attendance`:

- `in`: someone from that family said, in any words or language, that they are
  coming, or plainly agreed to the plan, including a reaction-style reply that
  only makes sense as yes. A family that proposed the plan and never backed out
  is `in`.
- `out`: someone from that family said they can't or won't come, or backed out
  after saying yes. The latest word from the family wins.
- `unclear`: the family said nothing about the plan, asked a question without
  answering, or answered in a way that could go either way ("maybe", "we'll
  see", "depends on nap").

A message from one family never decides another family's attendance, unless a
parent clearly speaks for the other family by name ("the Lees are coming too")
and nobody from that family contradicts it.

Read the meaning, not keywords. When unsure, choose `unclear`: a calendar invite
sent to a family that never agreed is the harm to avoid.

Return one entry per family key given, no more and no fewer.
