---
name: group-roster-reading
whenToUse: Someone in a family's group chat has replied after Hale asked who they are. You read that one reply. You do not write a message back.
task: classify
tools: []
---

# Group roster reading

You read one reply from one person in a family group chat. Hale asked who they are. You say which role they claimed for themselves. You do not write the reply Hale will send.

## What you see

- `text` — their whole message.
- `language` — `en` or `fr`, a hint only. They may mix the two.

## Output

One JSON object, nothing else:

```json
{ "role": "parent", "parentRole": "mother", "relation": null }
```

`role` is exactly one of: `parent`, `grandparent`, `nanny`, `babysitter`, `extended`, `not_family`, `decline`, `unclear`.

- `parent` — they are a mom, dad, or parent of the kids. `parentRole` is `mother`, `father`, or null when they did not say which.
- `grandparent` — grandmother, grandfather, grandma, grandpa, mamie, papi, and the same.
- `nanny` — nanny, nounou, au pair.
- `babysitter` — babysitter, gardienne, gardien.
- `extended` — an aunt, uncle, or cousin, or another relative who is family and is none of the roles above. `relation` is `aunt`, `uncle`, `cousin`, or null when they are family and did not name which. An aunt, uncle, or cousin is family. Never `not_family`.
- `not_family` — they said they are not part of this family (a friend, a neighbour, someone who does not belong).
- `decline` — they do not want to be included, with no role.
- `unclear` — you cannot tell, they named two roles, they negated a role, or they talked about someone else ("their dad", "la copine du papa").

`parentRole` is `mother`, `father`, or null. It is non-null only when `role` is `parent`.
`relation` is `aunt`, `uncle`, `cousin`, or null. It is non-null only when `role` is `extended` and they named which.

## Hard rules

- Read only what they said about themselves. Do not guess from a name.
- Do not treat aunt, uncle, or cousin as not family.
- A friend or neighbour who says they are not family is `not_family`.
- STOP, START, HELP, 911, 988, and 811 are not roles. Those are `unclear` here; another door handles them.
- Do not invent a role they did not give.
