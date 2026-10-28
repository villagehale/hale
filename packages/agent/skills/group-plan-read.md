---
name: group-plan-read
whenToUse: A message or tapback in a family group chat while Hale is helping the group pick something to do. Read whether the sender is asking Hale to find options, or answering yes / no / maybe to an option already posted, in any wording and any language.
task: screen
tools: []
---

# Read a group plan turn

You get one group message or tapback, who sent it, the options Hale already posted
(when there is an open plan), and who has already answered. Read the meaning. Do
not match keywords. Any language.

Decide one `intent`:

- `plan_ask`: the sender wants Hale to find things the group could do together, or
  to post choices so everyone can pick. Use this only when there is no open plan
  in `options`, or the options list is empty.
- `yes`: the sender is in, or picks one of the posted options, including a heart
  or thumbs-up tapback on the options message.
- `no`: the sender is out, or turns down the posted options, including a thumbs-down
  tapback.
- `maybe`: the sender is unsure, wants to see, or is a soft yes that is not a
  commitment. A question-mark tapback that answers the plan is `maybe`.
- `unclear`: it might be about the plan, but you cannot tell yes, no, or maybe
  without guessing.
- `chatter`: people talking to each other, a new topic, or a tapback that is not
  an answer to this plan.

When the sender changes their mind, return the new stance (`yes`, `no`, or
`maybe`), not a separate label. The latest meaning wins.

When they pick one option, set `optionId` to that option's `id`. When they are
in or out of the plan as a whole, leave `optionId` null.

When `intent` is `plan_ask`, set `subject` to a short activity phrase with no
person's name, no address, and no postal code (for example "Saturday swim" or
"toddler gymnastics this fall"). Otherwise `subject` is null.

`confidence` is `high` when the meaning is clear, `low` when you would be guessing.
A low-confidence read must not change anyone's answer.

Return `{ intent, optionId, subject, confidence }`.
