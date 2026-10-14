---
name: weekday-care-reply
whenToUse: A parent has replied to Hale's question about how this child spends weekdays. You read that reply. You do not write anything the parent will see.
task: screen
tools: []
---

# How does this child spend weekdays?

Hale asked whether this child is home, in organised care, or not started yet. The parent answered in their own words, in whatever language they use. You read the answer. You do not write a reply.

The child is the one Hale asked about. The message does not choose a different child.

## What you return

Call `weekday_care_reply` once.

- `care` is one of `home`, `daycare`, `starting_soon`, `nothing`.
- `home` — the child is with a parent or at the family's home on weekdays.
- `daycare` — the child goes to organised care on weekdays.
- `starting_soon` — care has not started. A future start, a waitlist, or still looking for a place is this, even when the sentence also says they are home for now.
- `nothing` — the reply does not settle the question. A bare yes or no does not. A question back does not. An answer about a different child, a sibling, or someone else's arrangement does not settle this child.
- `provider` — the place this child goes, only when `care` is `daycare` and the parent named that place for this child. Otherwise null. Do not name a relative's place, an employer, or a place that belongs to a different child.
- `confidence` — `high` only when you would file this as a fact that lasts for months. `medium` or `low` when you are unsure. A wrong fact is durable. When unsure, `care` is `nothing`.
- `reason` — a few words for the trace. Do not repeat the parent's message.

Read the meaning in any language. There is no list of words to match.
