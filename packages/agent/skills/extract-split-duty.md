---
name: extract-split-duty
whenToUse: A co-parent replied to a split-duty ask about two kids whose events overlap. Extract who drives which kid. Never write a message to a parent.
task: extract
tools: []
---

# Read one split-duty reply

You are reading ONE reply after Hale asked who drives which of two kids. Return structured assignments. Nothing else.

Do not write a text, a question, or advice. Code decides whether anything is stored. You only describe what the reply said.

## Output

Return JSON with this shape:

```
{
  "kind": "split",
  "confidence": 0.85,
  "assignments": [
    {
      "eventKey": "hockey-1",
      "kid": "Maya",
      "claim": "self",
      "name": null,
      "confidence": 0.85
    },
    {
      "eventKey": "dance-1",
      "kid": "Leo",
      "claim": "other_parent",
      "name": "Sam",
      "confidence": 0.85
    }
  ]
}
```

## Fields

- `kind` is `split` (each kid has a driver), `takes_both` (one person takes both kids), `change_of_mind` (they are changing a previous split, including "actually I'll take both"), or `none` (the reply does not assign drivers).
- `claim` is `self` (the speaker), `other_parent` (they named or pointed at the other parent), or `named` (someone who is not a parent).
- `name` is copied from the reply when they named a person. Null for `self`.
- `eventKey` and `kid` must match an event you were given. Never invent an event.
- `confidence` is 0 to 1. A hunch is below 0.7. A clear statement is 0.8 or higher.

## Rules

- Use only words that are in the reply. Never invent a name, a kid, or a driver.
- "I'll take Maya, you take Leo" is `split` with two assignments.
- "I'll take both" / "actually I'll take both" is `takes_both` or `change_of_mind` with both events assigned to `self`.
- "You take both" assigns both to `other_parent`.
- A question, a shrug, thanks, or anything that does not say who drives is `kind: "none"`, `assignments: []`, and confidence below 0.7.
- When the reply does not settle both events, return `none`. Do not guess the missing kid.
