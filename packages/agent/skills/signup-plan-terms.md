---
name: signup-plan-terms
whenToUse: Appended to signup-plan-reply when a registration ask carries terms Hale read from the program's page. It says how to state the price, the tax and the refund policy, what to say once the parent has said yes, and what to say when Hale stopped at checkout.
task: draft
tools: []
---

# Saying the terms

`facts.terms` is what Hale read on the program's page. Say only what it holds.

- `free`: true when the class costs nothing.
- `rates`: the prices this family may be charged, in cents, each `resident`, `non_resident` or `flat`.
- `residency`: whether this family counts as a resident of that town. `unknown` means the site decides from their account.
- `tax`: `plus_tax` means tax is added to those prices, `included` means none is added, `unknown` means Hale could not tell.
- `refund`: the provider's own words on refunds, or null.
- `ageFit`, `ageBand`: `in_band` means the child fits the ages the page gives. `unknown` means Hale could not confirm it.
- `prerequisite`: `required` `yes` means the class needs something first, in `quote` when the page says what.
- `priorChargeUnknown`: an earlier try at this class may have charged the card.
- `unread`: what Hale could not confirm on the page, by name.

## At `offer`, and at `clarify` when the terms have to be sent again

This text is what the parent says yes to, so it carries the terms. Say:

- The price. When `rates` holds one price, say it. When it holds a resident and a non-resident price and `residency` is `unknown`, give both, and say the site picks from their account. Write every price in `rates`, with its cents. `free`: say it is free, and state no price.
- That tax is added, when `tax` is `plus_tax`.
- The refund policy, in the provider's words, kept short, when `refund` is there. When it is null, say plainly that Hale could not find one, so they say yes knowing that.
- When `ageFit` is `unknown`, that Hale could not confirm the age fit and will stop at checkout for them to finish.
- When `prerequisite.required` is `yes`, name it and ask whether the child has it.
- When `priorChargeUnknown` is true, that an earlier try may have gone through, to check their card and email first, and that Hale will stop at checkout this time.
- Anything in `unread`, in a few words.

Keep it to a short text or two. Do not say the child is registered, and do not call the terms a deal or a guarantee.

## At `approved`

- `runsNow` true: Hale is starting now and will text when it is done. Give no time and no estimate.
- `hold` set: Hale will go as far as checkout and stop there for them to finish.
- Do not restate the terms.

## At `refused`

`refusal` `age_outside_band`: the child is outside the ages the page gives (`ageBand`). Say this class does not fit, and that Hale did not register them.

`refusal` `season_cap`: Hale has used this season's sign-ups on the family's plan, so it is not registering this one. The parent can register at the link.

## At `run_finished`

`run.detail` can also be:

- `cart_mismatch`: the cart differed from what the parent approved, so Hale stopped before paying and **nothing was charged**. `run.cartDifferences` says what: `price` (the total was not the price they approved; `run.cartTotalCents` is what the site showed), `fees` (a fee was added), `session` (a different class, day or time), `kid` (a different child on the registration), `quantity` (more than one), `unread` (Hale could not read the cart, so it could not confirm it). Say what differed in plain words, that nothing was charged, and, when `liveBrowser` is true, that the browser is open for them to look.
- `age_unconfirmed`: Hale could not confirm the age fit, so it stopped at checkout. Nothing was charged. They finish in the browser.
- `site_option`: this was a different option from the site than the one Hale read, so it stopped at checkout. Nothing was charged. They finish in the browser.
- `prior_charge_unknown`: an earlier try may have gone through, so Hale stopped at checkout rather than risk paying twice. Nothing was charged this time. They check their card and email, then finish in the browser if they need to.
- `terms_unreadable`: Hale could not read what the parent approved, so it did not register or charge anything. They can register at the link.

Never say registered unless `confirmed` is true.
