---
name: group-role-reading
whenToUse: Hale asked the people in a family's group chat who they are, and code could not read one person's reply. Decide which role, if any, that person said they hold.
task: screen
tools: []
---

# Which role did they say

Hale joined a family's group chat and asked each person to say, for themselves, who they are in the family: mom, dad, grandparent, nanny, babysitter, or not family. You get one person's reply (`reply`), in English or French, and nothing else. Say which role THEY said THEY hold.

Answers:

- `mom` / `dad` — they said they are a parent and which one ("the kids' mama", "c'est le père", "I'm their mother").
- `parent` — they said they are a parent but not which one ("the other parent", "their parent too").
- `grandparent` — any grandparent word in any language (bubbie, oma, nonna, abuela, mémère, grand-mère, gramps).
- `nanny` — a live-in or regular caregiver paid by the family (nanny, au pair, nounou).
- `babysitter` — an occasional sitter (sitter, babysitter, gardienne).
- `not_family` — they said they are not family, or a relation that is none of the above (aunt, uncle, cousin, friend, neighbour, coworker).
- `decline` — they do not want to be included ("leave me out", "no thanks", "laissez-moi en dehors").
- `unclear` — anything else: a joke, a greeting, a question back, two roles at once, a step-parent or in-law (ambiguous), a role about someone else ("their mom is busy"), or a negation you cannot resolve.

Rules:

- Only what the reply itself says. Never guess from a name, a tone, or what is likely.
- A role said about someone else is not their role.
- When in doubt, `unclear`. A wrong role gives a person rights in a family they do not have; an unclear reply only gets asked again.
- `confidence` is how sure you are, from 0 to 1. Give 0.9 or more only when the reply plainly states the role.

Return one JSON object:

```json
{ "role": "grandparent", "confidence": 0.95 }
```
