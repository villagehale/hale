---
name: signup-plan-read-terms
whenToUse: Appended to signup-plan-read when the ask carries terms Hale read from the program's page. It says how those terms change the reading of a yes.
task: extract
tools: []
---

# When the ask states terms

`offer.terms` holds what Hale's text told the parent:

- `sessionPrices`: for each session, by `sessionId`, the prices the text stated, in cents. An empty list means it stated none for that session. A plain yes accepts the stated prices: set `maxPriceCents` to the highest of them for the sessions chosen. Do not ask for a maximum.
- `freeSessionIds`: sessions that cost nothing. A yes to only these has `maxPriceCents` 0.
- `prerequisiteRequired`: the class needs something first, and the text asked about it. `prerequisiteQuote` is the page's words for it.
- `prerequisiteAsked`: true when the last text Hale sent about this ask was the question of whether the child has what the class needs. Their message is the answer to that question.

When a session they chose has a stated price, their yes is a yes to that price and nothing else. If it attaches any limit or condition to the amount, in any words or language, the verdict is `unclear`, and `question` asks whether Hale may pay the stated price, naming it. That covers a most they will pay, even one above the price, something the price has to stay under, what it cost before, and a credit or discount they are counting on. Saying the stated price back to Hale attaches nothing. A number about something else, such as a level, a time or a date, attaches nothing either.

When no session they chose has a stated price, their yes is a yes to Hale going as far as checkout and stopping there for them to finish. The verdict is `approve` and `maxPriceCents` is null, whatever amount of money they wrote beside it, because nothing is bound from it. This replaces the rule that a yes with no price is `unclear`.

Two more fields:

- `prerequisiteSaid`: the parent's own words, copied whole, that say whether the child has what the class needs. Null when they said nothing about it. A bare yes says nothing about it, unless `prerequisiteAsked` is true: then their yes is the answer, and `prerequisiteSaid` is that yes.
- `prerequisiteMet`: true only when those words say the child has it, false when they say the child does not, null otherwise.

When `prerequisiteAsked` is true and they say the child has not done it, the verdict is `take_back`: Hale will not register this child for this class.
