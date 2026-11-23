---
name: browser-use-price-unstated
whenToUse: Appended to a registration run when Hale could not find the class's price. It says that `max_price_cents` is null, so no price stops this run, and that the run ends where it always ends for the parent to finish.
task: plan
tools: []
---

## This class has no known price

`max_price_cents` is null because Hale could not find this class's price. There is no limit to compare, so no price on the page is a reason to stop or to skip a choice, and you do not use `price_change`. Copy the price the page shows into the output fields as usual.

Everything else holds. Go only as far as your steps say and stop there: the parent sees the real price and finishes in the browser.
