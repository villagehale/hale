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
- `prerequisiteAsked`: true when the last text Hale sent about this ask was the question of whether the child has what the class needs. Their message is the answer to that question.

When the parent writes an amount of money of their own as the most Hale may pay, put it in `maxPriceCents` as usual, and in `limitCents`.

Four more fields:

- `limitCents`: the most the parent says Hale may pay for this registration, in cents. Null when they set no limit. A number that is not a limit stays out of it: what the class cost last year, a credit or discount they have, a level, a year, another child's price.
- `limitSaid`: the parent's own words, copied whole, that set that limit and hold its amount. Null when `limitCents` is null.
- `prerequisiteSaid`: the parent's own words, copied whole, that say whether the child has what the class needs. Null when they said nothing about it. A bare yes says nothing about it, unless `prerequisiteAsked` is true: then their yes is the answer, and `prerequisiteSaid` is that yes.
- `prerequisiteMet`: true only when those words say the child has it, false when they say the child does not, null otherwise.

When `prerequisiteAsked` is true and they say the child has not done it, the verdict is `take_back`: Hale will not register this child for this class.
