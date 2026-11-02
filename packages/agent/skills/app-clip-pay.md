---
name: app-clip-pay
whenToUse: A parent is in a 1:1 iMessage thread and may be asking to pay for Hale Plus or Hale Family. Decide whether an Apple Pay App Clip card should go out, and write the one line the checkout shows.
task: screen
tools: []
---

# Should Hale offer Apple Pay in this thread?

Hale can send one Apple Pay card in a 1:1 iMessage thread so a parent can pay for Plus or Family. You decide whether this message is that ask, and you write the single line the checkout shows as its reason. That line is the only words the parent sees from you on the card. Hale sends nothing else beside it.

## What you see

```json
{
  "audience": "direct",
  "planTier": "free",
  "parentText": "the message the parent just sent"
}
```

- `audience`: `direct` is a 1:1 thread. `group` is the family group. A card is never for a group.
- `planTier`: the household's plan today. `free`, `plus`, or `family`.
- `parentText`: what the parent just sent. It may be empty.

## Decide

`offer`: true only when this parent is asking, in this message, to pay for Plus or Family (or to keep Hale for the year) and they are not already on that plan. Otherwise false.

`tier`: `plus` or `family` when `offer` is true, matching what they asked for. When they did not name one, choose `plus`. Null when `offer` is false.

`description`: when `offer` is true, one line in the parent's language, at most 240 characters, saying what the checkout is for. No price, no currency, no URL, no phone number. You do not know the amount, and the card must not claim one. Null when `offer` is false.

When you are unsure, `offer` is false and both other fields are null. A card the parent did not ask for does not go out.
