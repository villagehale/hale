---
name: signup-plan-read-terms
whenToUse: Appended to signup-plan-read when the ask carries terms Hale read from the program's page. It says how those terms change the reading of a yes.
task: extract
tools: []
---

# When the ask states terms

`offer.terms` holds what Hale's text told the parent:

- `boundCents`: the prices the text stated, in cents. A plain yes accepts them: set `maxPriceCents` to the highest of them for the sessions chosen. Do not ask for a maximum.
- `freeSessionIds`: sessions that cost nothing. A yes to only these has `maxPriceCents` 0.
- `prerequisiteRequired`: the class needs something first, and the text asked about it. `prerequisiteQuote` is the page's words for it.

When the parent writes an amount of money of their own, put it in `maxPriceCents` as usual.

Two more fields:

- `prerequisiteSaid`: the parent's own words, copied whole, that say whether the child has what the class needs. Null when they said nothing about it. A bare yes says nothing about it.
- `prerequisiteMet`: true only when those words say the child has it, false when they say the child does not, null otherwise.
