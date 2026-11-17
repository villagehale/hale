# Launch red-team — Dec 1, 2026 public launch (US + Canada)

Read-only review of `main` at `4cd22e825` (Plus season cap, #1301), on 17 Nov 2026. No flags, env, Stripe, ads, or messages were changed. Production env values are not in the repo; where the plan says a flag is live, this report treats that as the intended Prod setting and checks what the code does with it.

Severity × likelihood is the sort. Critical means a parent is charged the wrong money, a city password leaves Hale, Hale keeps texting after a stop, or the product goes silent for everyone. Likelihood is how often that happens if Dec 1 proceeds on the current plan.

## Verdict

Do not open public signup, ads, or holiday checkout on 1 Dec on this build and this plan. The date is 14 days away. The model that answers every parent is a **$200 test-key credit that expires 4 Dec 2026, 7pm ET** (VIL-658: the test key is shared with Prod). Three days after launch the bill dies, and the hourly proactive job that would be carrying the new families does not share the abort switch the nudge sweep already has. Taking money the same week is worse: the Stripe billing webhook still returns **501** until a secret exists, `MAX_ENTITLEMENTS_ENABLED` is already on, and a refund does not revoke the tier unless someone runs an ops script that also cancels.

The work still on the board (VIL-692, 690, 613, 541, 696, 560, 694, group scenes, then VIL-658) does not include that. Several of those tickets are worth doing. None of them is the thing that breaks launch week.

## Ranked findings

| # | Score | Finding | Owner |
| --- | --- | --- | --- |
| 1 | Critical × high | $200 test key expires 4 Dec; proactive review has no credit abort and no family cap | Barton |
| 2 | Critical × high | Promo checkout can charge CAD as a plain `$`, and a missing USD list price falls back to a CAD price id | Barton |
| 3 | Critical × high | Webhook 501 + no refund revocation, while Max caps are already on | Barton |
| 4 | Critical × high | City passwords are sent inline to Browser Use; the plan run starts 3 minutes before open; a failed run burns a season slot | Barton |
| 5 | High × high | `PROACTIVE_CADENCE=off` still texts first for five lanes, and nothing caps how many texts land | Barton |
| 6 | High × high | Co-parent join and caregiver welcome still send fixed copy that teaches STOP | Barton |
| 7 | High × medium | A failed opt-out read still gets a reply; an in-flight group reminder still lands after STOP | Barton |
| 8 | High × medium | A multi-family aside puts every present household's kids and times in one model call, without join consent | Barton |
| 9 | High × medium | A US family with no single timezone stays on UTC, so quiet hours and the season cap use the wrong clock | Barton |
| 10 | High × medium | We would notice a total outage and miss a quiet one; the kill switch needs a redeploy and does not stop work already running | Barton |

---

### 1. The model budget dies on 4 Dec, and the busiest new job does not stop when it does

**Score:** critical × high.

**Evidence**

- VIL-658 (Todo, due 29 Nov): "The test key is shared with Prod." Paid evals and production calls draw the same credit.
- Credit paging is off unless `ANTHROPIC_CREDIT_ALERT_ENABLED` is exactly `true`. Remaining balance is `ANTHROPIC_CREDIT_START_USD` minus rows in `anthropic_spend`. A failed spend write is swallowed.

```25:33:apps/web/lib/monitoring/anthropic-credit.ts
 * Prepaid Anthropic credit #ops alert. Remaining = ANTHROPIC_CREDIT_START_USD
 * minus anthropic_spend since ANTHROPIC_CREDIT_START_AT. Dark unless
 * ANTHROPIC_CREDIT_ALERT_ENABLED is exactly `true`.
```

```395:401:apps/web/lib/monitoring/anthropic-credit.ts
async function recordSpendSafe(row: AnthropicSpendRow): Promise<void> {
  try {
    const { db } = await import('~/lib/db');
    await recordAnthropicSpend(db(), row);
  } catch {
    // Tracing / spend recording must never fail a model call.
  }
}
```

- `providerPreflight` aborts a window on a billing failure. It is wired for the nudge sweep, memory inference, opt-out recovery, first-reply recovery, and registration verify. It is **not** called from `runProactiveReview`.
- The proactive cron allows 300s and then walks every family that has a queued or held row. `FAMILY_ROWS` (40) caps rows per family. It does not cap families. Inference and the memory digest do (`MAX_FAMILIES_PER_RUN` 100 and 50).

```6:7:apps/web/app/api/cron/proactive-review/route.ts
export const runtime = 'nodejs';
export const maxDuration = 300;
```

```288:292:apps/web/lib/channel/proactive/review.ts
  const families = await database
    .selectDistinct({ familyId: schema.proactiveCandidates.familyId })
    .from(schema.proactiveCandidates)
    .where(inArray(schema.proactiveCandidates.status, ['queued', 'held']));
  for (const { familyId } of families) {
```

- Under `live`, a nudge is composed by the sweep (`nudge/run.ts` ~821) and then composed again by the review, because `nudge` is not a verbatim kind (`proactive/verbatim.ts`). The decider is a third call (`DECIDER_MAX_TOKENS = 1500`).
- A live decision that fails stays queued and is retried every hour. Each failure pages #ops (`review.ts` 1029–1034, site `proactive_decider_failed`). That page was added in #1298. It does not stop the next family, and it does not stop the next hour.
- `check_spending_cap` is the reviewer's check on a **purchase**, not on tokens (`apps/worker/src/tools/registry.ts`).
- VIL-136 ("Harden the agent pipeline for public load") is Canceled.

**Failure.** Ads or a group-chat forward lands a few hundred families on 1–2 Dec. Each inbound turn is several Sonnet calls (30s timeout, one retry). Each hour the review adds a decider call and often a writer call per family, on top of the nudge compose that was thrown away. The $200 line is crossed before 4 Dec, or the key expires at 7pm ET on the 4th while parents are still texting. Nudge and inference abort. Proactive review keeps calling, paging once per family per hour. Inbound turns defer (`TurnDeferred` on billing; retry 8 times from 15s) and the parent gets nothing. The credit alert never fires if the flag was left at its default.

**Fix.** Before any public traffic: a paid Anthropic account with a budget that is not the eval key, `ANTHROPIC_CREDIT_ALERT_ENABLED=true` with start, alert, and `ANTHROPIC_CREDIT_EXPIRES_AT` set, and `providerPreflight` at the top of `runProactiveReview` and the other LLM crons that lack it. Cap families per review the way inference does. In `live`, do not compose the nudge on the sweep. One #ops page per hour, not per family. Do not launch while Prod and the eval cache share one prepaid key.

---

### 2. A visitor who is not clearly in the US is charged CAD, and the price is a bare dollar sign

**Score:** critical × high, the moment `HOLIDAY_PROMO_ENABLED` is turned on. The flag is off today. The window is already open (Black Friday through 27 Nov, Holiday Sale 28 Nov–31 Dec, America/Toronto). Launch day sits inside the Holiday Sale.

**Evidence**

- Anything other than the header `US` is CAD, including a missing header, Canada, and every other country.

```64:66:packages/types/src/promo.ts
export function currencyFromIpCountry(countryHeader: string | null | undefined): BillingCurrency {
  const country = countryHeader?.trim().toUpperCase();
  return country === 'US' ? 'USD' : 'CAD';
}
```

- The sale label is `$${sale}/yr` with the currency kept off the price (`apps/site/lib/promo/holiday.ts` 70–88, 174). US Plus is $39, CA Plus is $59, US Max $79, CA Max $99. A parent cannot see which one they were shown.
- Checkout uses the same function on the **web** app's copy of `x-vercel-ip-country` (`apps/web/app/api/billing/checkout/route.ts` 74). The 409 `currency_changed` runs only when the client sent `expectedCurrency` (lines 78–79). A caller that omits it is charged whatever that request's header says.
- After 1 Jan 2027, a US Plus checkout whose USD list price id is unset is given the **CAD** price id. Max does not do this; Plus does.

```353:358:apps/web/lib/billing/prices.ts
  const native = listSelection(input.currency, input.period, env);
  if (native) return { status: 'selected', price: native };
  if (input.currency !== 'CAD') {
    const cad = listSelection('CAD', input.period, env);
    if (cad) return { status: 'selected', price: cad };
  }
```

- `paidTierFromUnknown` maps every value other than `family` or `max` to Plus (`prices.ts` 92–96), including a missing tier and `"Max"`.

The homepage `currency = 'CAD'` default (`apps/site/app/[locale]/page.tsx` 34) applies to the list-price surface. During the founding window that surface is `legacy`, and the sale cards take currency from `resolveHolidayPromo`, which does use the IP header. The bug is the header rule and the bare `$`, not a hardcoded CAD sale card.

**Failure.** A US parent on a connection whose edge country is empty, or a Canadian who is travelling and thinks "$59" means USD, pays 59 CAD (about 42 USD) for Plus or 99 CAD for Max. The receipt is the first time the currency is unambiguous. On 2 Jan, a US Plus price id that was never created charges the CAD list price ($159) instead of refusing.

**Fix.** Unknown country is not CAD: show an explicit CAD/USD choice and refuse checkout until one is confirmed. Print the currency code next to the amount on the sale card and the Stripe line. Delete the USD→CAD fallback; missing price id is `no_price`. Reject an unrecognised tier instead of selling Plus. Owner: Barton, before `HOLIDAY_PROMO_ENABLED` is set.

---

### 3. Paying does not grant Max, and refunding does not take it away

**Score:** critical × high as a launch sequence. The live Stripe account is not activated and the promo flags are off, so this is not charging anyone today. The entitlements flag those charges would drive **is** on (#1292, #1301).

**Evidence**

- With no `STRIPE_WEBHOOK_SECRET`, every Stripe billing event returns 501 and writes nothing.

```40:45:apps/web/app/api/webhooks/[provider]/route.ts
    if (verification.status === 'not_configured') {
      return NextResponse.json(
        { error: 'stripe_billing_not_live', detail: verification.reason },
        { status: 501 },
      );
```

- Tier changes come from `customer.subscription.deleted` (back to free), subscription created/updated (price id → tier), `checkout.session.completed`, and `invoice.paid` (`apps/web/lib/webhooks/stripe-billing.ts` 241–264). There is no `charge.refunded` arm. A refund that does not also delete the subscription leaves `plan_tier` where it was.
- `refund_ready` means "a disallowed price was used." It does not refund. It pages #ops and grants nothing (`stripe-billing-apply.ts` 32–40).
- The only full refund in the repo is an ops function. It is a dry-run unless `apply` is true, and it then cancels. There is no parent-facing refund.

```5:8:apps/web/lib/billing/refund-family.ts
 * Ops path: full refund of a family's latest paid Stripe charge, then cancel
 * the subscription. Omitting `amount` on Stripe's Refunds API is a full refund
```

- The sale copy is `Full refund anytime if it's not for you.` (`apps/site/lib/promo/holiday.ts` 95).
- With `MAX_ENTITLEMENTS_ENABLED` on, a family whose `plan_tier` is still `free` gets Plus caps: 3 searches, 2 finds, 8 watches, 2 Browser Use sign-ups a season. Max (the `family` tier) is 8 / 4 / 20 / unlimited (`packages/types/src/entitlements.ts` 65–80). Priority support is an ops sort key, not a support channel (`compareOpsPriority`, lines 95–100).
- Checkout itself 501s until the price flag and `APP_URL` exist (`checkout/route.ts` 99–109). That protects a flag-off launch. It does not protect the order "turn on checkout keys, register the webhook later."

**Failure.** Promo is switched on, a parent pays $79 for Max, the webhook secret is missing or pointed at the wrong endpoint, Stripe retries 501s, and the family stays `free`. Hale tells them, in the model's words, that they are on the free caps. Support refunds the charge from the Stripe dashboard and does not cancel. The row stays `family` if a later `invoice.paid` or a manual edit had set it, or stays `free` if the grant never landed. Either way the parent and the ledger disagree. "Refund anytime" is a sentence on the site and a script nobody has run against live.

**Fix.** One gate: checkout returns 501 until a signed test event has been applied in Prod and a reconciliation query shows zero paid customers with `plan_tier = free`. Handle `charge.refunded` and `charge.dispute.created` by setting `free` unless a non-refunded subscription is still active. Put a refund button in the receipts app that calls `refundFamilyLatestPayment` with `apply: true`, or change the site line to "text us and we refund." Do not advertise Max priority support until it is more than a sort. Owner: Barton. This blocks the promo flags. It does not block a free launch.

---

### 4. Registration can log in early, on the wrong attempt, with the password in the vendor's request

**Score:** critical × high if `REGISTRATION_PLAN_RUN_ENABLED` and `BROWSER_USE_SIGNUP_ENABLED` are on, which VIL-658 says they are lit at merge for cities that passed a live check.

**Evidence**

- The product rule is: store the city login encrypted, run a generic Browser Use agent after the registration opens, no 7am race. The plan sweep joins **three minutes before** `plan_opens_at`.

```62:63:apps/web/lib/signup/plan/run.ts
/** Hale joins the open this long before it, the way a punctual parent would. */
export const PLAN_JOIN_LEAD_MS = 3 * 60_000;
```

The claim query uses `plan_opens_at <= now + lead` (`plan/store.ts` ~255–268). A 7:00 open can be claimed at 6:57. The cron is every minute (`apps/web/vercel.json`, `signup-plans`).

- The season allowance is claimed **before** the run. The `catch` returns `engine_threw` and does not give the slot back (`apps/web/lib/signup/run.ts` 956–1022). Plus and Free, with the entitlements flag on, get 2 attempts per season. The season is the parent's `users.timezone` (`registration-season.ts` 53–71; invalid zones fall through to UTC).
- Passwords and TOTP are not put in the model task. They are put in the Browser Use `createRun` body as `secretBindings` with `source: { type: 'inline', value }` (`apps/web/lib/signup/credentials/bindings.ts` 34–51). The API is `https://api.browser-use.com/api/v4` (`browser-use/client.ts` 9–10). `allowedDomains` limits where the agent types them. It does not limit who at Browser Use can read the request.
- At rest, one env var wraps every family: `PROVIDER_CREDENTIALS_MASTER_KEY`, AES-256-GCM, `CURRENT_MASTER_KEY_VERSION = 1` (`credentials/kms.ts` 14–15, 23–34). There is no second version to rotate to.
- `loadCredentialsForRun` loads by family and host, not by the parent who saved them (`credentials/store.ts` ~105–118). A co-parent's plan run uses the other parent's city login.
- Payment on that path is `signupSpendingCap` (the approved price, max $500), not the reviewer tool `check_spending_cap` (`signup/run.ts` 1035). `BROWSER_USE_SIGNUP_PAYMENT_ENABLED` is a separate flag and is off unless set. If it is turned on with the plan runner, a charge can happen at open without a new "yes" that morning.
- VIL-675 (record every run's outcome by city and vendor) is Backlog, labelled launch:post. VIL-694 (the registration-note writer offers to change the morning, says "everything else is set", repeats "may not have loaded") is Backlog with the four drafts on `EXPECTED_FAIL`.

**Failure.** A Toronto parent saves their EFun login. At 6:57am the plan runner starts. The site is not open; the agent retries, errors, or sits in a queue the city treats as a bot. The Plus family has used 1 of 2 winter attempts. The password was in the JSON to Browser Use. A second morning fails the same way and the third real registration is refused for the season (`season_cap`). The parent hears, if the writer is having the week VIL-694 describes, that Hale can move the morning or that everything else is set.

**Fix.** `leadMs` 0, and refuse to claim until `now >= plan_opens_at` in the family zone. Claim the season slot only after a confirmed registration, or release it on `engine_threw`. Bind credentials to the parent who saved them. Get Browser Use's written no-retention terms for `secretBindings` (VIL-658 already asks for the CAPTCHA letter; add this) before any city password is stored for a family that is not Barton's. Pull VIL-694 and VIL-675 in front of any new registration copy. Owner: Barton (VIL-558).

---

### 5. Turning the cadence flag off does not make Hale quiet, and nothing counts the texts

**Score:** high × high. #1298 merged 17 Nov and left `PROACTIVE_CADENCE` unset. Unset is `off` (`packages/flags/src/catalog.ts` 244–251). The plan says Prod is `live`. Both states misbehave.

**Evidence**

- `off` does not return. It still reviews five kinds, and the code says they are reviewed live while the flag is off.

```283:286:apps/web/lib/channel/proactive/review.ts
  if (mode === 'off') {
    await reviewEveningCheckIns(database, deps, now, summary);
    return summary;
  }
```

```504:516:apps/web/lib/channel/proactive/review.ts
 * Kinds with no sweep of their own left to send them: the evening check-in, the VIL-393
 * mid-activity ask, the VIL-681 next-day check-back, the VIL-684 own-city registration
 * opening and the VIL-685 winter-break ask. They are reviewed live even while the
 * cadence flag is off.
const DECIDER_ONLY_KINDS: readonly ProactiveSendKind[] = [
  'evening_check_in',
  'mid_activity_ask',
  'next_day_checkback',
  'registration_opening',
  'school_break_ask',
];
```

The cron comment says the opposite: "While PROACTIVE_CADENCE is unset this returns at once and reads nothing" (`proactive-review/route.ts` 10–12).

- `registration_sequence`, `spot_open_instant`, `autonomy_armed`, and `autonomy_acted` are `immediate` (`proactive/flag.ts` 39–59). They send on their own clock in every mode. The registration ladder cron is `*/5 * * * *`.
- There is no count cap. Twelve texts in a day page #ops **after** they have been sent.

```27:30:apps/web/lib/channel/outbound-gate.ts
 * There is no count cap. Opt-out, quiet hours, same-item dedupe, Linq 429 handling
 * and line-health are the code rails. Whether to send, and how often, is the
 * model's decision.
```

```1:3:apps/web/lib/channel/proactive/volume.ts
 * VIL-226 · an alert, not a cap. A family past this many outbound texts in a day is
 * unusual enough to page #ops. The send is not held.
```

- `live` is strict equality with no trim (`flag.ts` 16–17). `live\n` from `vercel env add` stays `off`. If `POSTHOG_FLAGS_ENABLED` is on, a PostHog `proactive-cadence` value wins over the env (#1298). Idempotency keys on Linq sends are attached only when cadence is not `off` (`linq/transport.ts` 88–94, 451–452). A rollback to `off` also turns duplicate protection off.
- VIL-691 is Done. Its five live-only bugs (double email alert, stuck holds, paging, eval fixtures, dedupe) are fixed in #1298. The eight new decider fixtures were cache misses at merge; the PR says the paid record was not run.

**Failure.** Launch week, a bug or a bad decider snapshot sends a registration ladder text, a winter-break ask, and an evening check-in to the same parent between 5pm and 8pm. Ops sets `PROACTIVE_CADENCE=off` and redeploys. The ladder keeps firing every five minutes. The five decider-only kinds keep being decided and sent. The parent who texts STOP is a different finding; this parent just wanted fewer texts and still gets them. If the value was `live\n`, Prod was never live and the old paths plus those five kinds have been sending the whole time.

**Fix.** `off` means no unprompted send, including the five kinds and the immediate classes, except a reply to a text the parent just sent. A per-family daily cap (3 is enough for launch) inside `assertProactiveSendAllowed`, not a page at 12. Confirm in PostHog that `proactive-cadence` is absent or exactly `live`, then set the env with no trailing newline, then read one Prod decision row before calling it live. Record the eight #1298 decider fixtures before trusting the eval gate. Owner: Barton.

---

### 6. Two live paths still teach STOP in fixed copy

**Score:** high × high. These are not dead strings. Tests assert the bodies that were sent.

**Evidence**

```62:64:apps/web/lib/channel/join/copy.ts
export function joinWelcome(inviterName: string | null): string {
  const who = affordableInviterName(inviterName) ?? 'your co-parent';
  return `You're in - ${who} added you as a co-parent, so you see what they see here and can text me anything, anytime. Reply STOP anytime.`;
}
```

Sent at `apps/web/lib/channel/join/route.ts` 360–367. The inviter also gets the fixed `JOIN_ACCEPTED_ACK` (line 68, sent at 382–388).

```41:44:apps/web/lib/channel/caregiver/copy.ts
export const CAREGIVER_WELCOME =
  "You're in - I'll text you the week's schedule and pickup reminders, and nothing else. Reply STOP anytime.";

export const CAREGIVER_DECLINE_ACK = "No problem - I won't text you again.";
```

Sent at `caregiver/route.ts` 514–520 and 527–529. The same file also sends `ADD_EXAMPLE` and `CO_PARENT_REDIRECT` (lines 53–68).

The friend-voice judge rejects this shape (`friend-voice.test.ts` 882–888, reason `compliance`). The join and caregiver doors never ask that judge. The opt-out reader itself does not teach STOP; a failed compose on the onboarding path sends nothing (`docs/launch-runbook.md` 69). The OTP text is fixed and does not mention STOP (`otp-sender.ts` 23–24). That one is a verification code, not a lesson.

`apps/web/lib/channel/types.ts` 13–23 still requires every loop template to keep a deterministic fallback and to send it when voice is null. `LOOP_SEND_ENABLED` is exact-`true` and therefore off when unset. Turning that flag on reopens the fallback. Group reminders already page instead of sending when voice is missing (`loop/reminders/group/capture.ts` 269–290). The loop contract does not.

**Failure.** A parent forwards a co-parent link. The new number's first Hale message is a template that ends "Reply STOP anytime." That is the copy the product rule forbids, and it teaches the keyword the product refused to teach. A caregiver who says yes gets the same lesson.

**Fix.** Run join welcome, the inviter ack, and the caregiver yes/no lines through the same writer as onboarding. If that writer returns nothing, send nothing and page #ops; the seat change has already been recorded. Delete the STOP sentence from those specs. Change the loop voice contract so a null voice holds the send, before anyone sets `LOOP_SEND_ENABLED`. Owner: Barton.

---

### 7. "Stops at once" is not true for an unread stop, or for a reminder already in flight

**Score:** high × medium.

**Evidence**

- Every inbound with text is read by the model. A null read (failed twice) sets `optOutUnread` and tries to hold the number (`intake/machine.ts` 584–597, 4038–4074). The hold blocks **proactive** sends (`outbound-gate.ts` 471–474). It does not stop the turn. A post-intake text with a failed read is handed to the conversation (`inbound-route.ts` 205–207) with `opt_out_unread` on the job, and the coach still runs. Signup asks are the exception: they refuse to move (`signup/run.ts` 247–259, `offer-tool.ts` 191–196).
- If the hold insert throws, the comment is explicit: "The hold is a guard, never a reason to drop the turn: the turn goes on." #ops gets `opt_out_hold_unwritten` (`machine.ts` 4065–4071). There is then no hold and no stop.
- Group reminders: STOP cancels `pending`, `scheduled`, and `sending`. `in_flight` is not in `CANCELLABLE` (`loop/reminders/group/store.ts` 22, 144–151). The comment says the one already going out is left to land.

**Failure.** During a partial model failure the opt-out reader returns null and the coach still answers. The parent wrote "please stop texting me." Hale replies with a normal answer and, if the hold row failed, also sends tonight's check-in. Separately, a group reminder that the tick already marked `in_flight` posts into the thread after that parent stopped Hale there.

**Fix.** `reading === null` ends the turn with no coach send. Retry the read; do not answer. A hold-write failure is the same: no outbound, page `opt_out_hold_unwritten`, and leave the message unclaimed so the retry can read it. Cancel `in_flight` group reminders that have not received a provider id yet; if the provider already accepted the send, record `landed_after_stop` on the audit row so it is visible. Owner: Barton. VIL-553 and #868 built the hold. The hold is not a stop.

---

### 8. Multi-family aside loads every present family's kids and times into one prompt

**Score:** high × medium. VIL-399 and the group-scene proof (VIL-689, in progress, due 20 Nov) are the right tickets. This hole is not closed by them.

**Evidence**

`runPrivateAside` loads every household that is present, not stopped, and not marked out. It does not call `joinConsent`.

```278:305:apps/web/lib/channel/linq/group-private-aside.ts
  // Presence, not a join: a household hears about its own facts 1:1 while someone from it
  // is here, has not stopped Hale here, and its parent has not said it is out.
  const familyIds = await presentHouseholds(database, input.chatId, {
    includeStopped: false,
    includeLeft: false,
  });
  // ...
    families: familyIds.map((id) => ({
      ref: refOf.get(id) as string,
      kids: slices.get(id)?.children ?? [],
      times: privateTimesOf(slices.get(id) ?? { memory: [], calendar: [], signups: [] }),
    })),
```

`readFamilySliceForAudience` includes that family's children, calendar lines, email subjects, and signups (`linq/multi-family.ts` ~921–996). The common-time path and the plan directory do check `joinConsent` (`multi-family.ts` 855, 1277, 1391). The aside does not. The 1:1 is sent to the family the model picked. The prompt that made the pick contained every family's kids and times.

**Failure.** Two families share a school chat. Family B has not consented to join. Someone mentions a Tuesday practice. The model call contains B's child's name and B's calendar times next to A's. The aside to A names B's child, or the provider log does. B never agreed to that use.

**Fix.** Same `joinConsent(...).allowed` gate as `joinedFamiliesDirectory` before a slice is built. A household without it contributes nothing to the prompt and gets no aside. If the read fails, send nothing (`read_failed` already returns). Owner: Barton. Do not light more group scenes until this gate has a test with two families and one missing consent.

---

### 9. US families whose city has no single zone keep the UTC default

**Score:** high × medium. DST math itself is in good shape: quiet hours use `Intl` (`loop/prefs.ts` ~169). America/Regina and America/St_Johns work when they are actually stored. The bug is the families who never get a zone.

**Evidence**

```46:46:packages/db/src/schema/users.ts
    timezone: text('timezone').notNull().default('UTC'),
```

Provisioning writes a zone only when it has one. A city whose areas disagree, or a parent who gives no place, keeps the default. The comment says that is intentional and that the clock was never set.

```51:56:apps/web/lib/channel/intake/provision.ts
 * Canada. A city whose areas do not share one zone has a null timezone: the
 * user keeps the column default, which means the clock was never set.
```

```113:120:apps/web/lib/channel/intake/provision.ts
async function ensureIntakeUser(
  tx: Database,
  externalAuthId: string,
  timezone: string | null,
): Promise<string> {
  await tx
    .insert(schema.users)
    .values({ externalAuthId, email: null, name: null, ...(timezone ? { timezone } : {}) })
```

`parentTimezone` in the signup runner uses that column and falls back to UTC again (`signup/run.ts` 1140–1146). Registration season boundaries and proactive quiet hours both read it. Quiet hours are 21:00–08:00 in that zone (`outbound-gate.ts` 42–44).

**Failure.** A US parent names a city the area table will not reduce to one zone, or skips the place. Hale treats them as UTC. "Quiet" is 4pm–3am Eastern. The winter season cap rolls at 00:00 UTC, which is 7pm Eastern the night before. A 9pm text the parent thinks is allowed is held, or a 5pm text they think is evening goes out as if it were afternoon. Canada postal codes that resolve (Toronto, and a single-zone FSA) are fine. The US launch is the gap.

**Fix.** If the zone is null, ask once, in the model's words, and do not send unprompted until a zone is stored. Do not guess from the phone number (the provision comment is right about that). Do not leave UTC in place and hope. Owner: Barton, with the VIL-413 place work (#1299).

---

### 10. A dead line pages someone. A wrong line does not. Rollback is a redeploy that does not reach in-flight work.

**Score:** high × medium.

**Evidence**

- No Sentry project in the tree. Errors are `console` plus PostHog when `POSTHOG_ERROR_TRACKING_ENABLED` is exactly `true` (`apps/worker/src/analytics/flags.ts` 20–23). The launch runbook's inbound steps cite "the webhook playbook." There is no such file under `docs/`.
- The inbound canary (every 10 minutes) and the unanswered sweep (a real parent text with nothing after 15 minutes) will catch a total blackout (`docs/launch-runbook.md` 87–89). They will not catch Hale sending the wrong price, the wrong family's child, or a template. A model failure that correctly sends nothing looks like a quiet family (`onboarding-friend: reply not sent` is a log line and a page; many other skips are `console.info`).
- Kill switch: change the Vercel env and **redeploy** (`docs/flag-rollout-checklist.md` 9–10). `signup-plans` returns immediately when the flag is off (`plan/run.ts` ~180), but a plan already in `submitting` keeps its lease (`PLAN_LEASE_MS` is 15 minutes, `plan/run.ts` 74–75). pg-boss jobs already queued keep their payload.
- `NEXT_DAY_CHECKBACK_ENABLED` and `SECRET_SANTA` use `trimmed-not-false` and default **on** (`packages/flags/src/catalog.ts` 151–154, 226). A new Prod env that forgets the variable turns them on.
- VIL-696 (Todo, due 24 Nov, no owner): every `main` merge promotes to Production. On 11 Nov, #1226 took Prod down from 7:19am to 9:18am ET. The fix was #1242 and a manual rollback. Nothing in CI sends a Linq test text and requires a reply before promote.
- VIL-658 (Todo, due 29 Nov, no owner): one Prod journey per landing promise, on Barton's or Eugene's family, or a waiver. It is still the only launch gate, and it has no evidence attached. VIL-560 (prompt injection from email, calendar, and web pages) is In Progress, due 26 Nov. That suite does not exist yet, and registration plus Gmail are already in the launch set.

**Failure.** A bad merge on 30 Nov ships at 8am ET. Parents get silence or garbage for two hours, which is what happened on 11 Nov, except now they are not the founders. Or the merge is fine, the credit dies on 4 Dec, sends stop, and the only page is a per-family decider failure that looks like noise. Or someone "turns registration off" during an incident and the run that started a minute earlier finishes the city's checkout.

**Fix.** VIL-696 before any further launch merges: one Linq test-line round trip on the build, or the previous deployment stays. Set `POSTHOG_ERROR_TRACKING_ENABLED` and the credit alert. Add a counter of outbound sends and of `skipped` by reason, and page when sends drop to zero during 8am–9pm Toronto on a weekday. An env kill must also set a row the sweep reads every minute, so in-flight plans abort without a redeploy. Owner: Barton for the gate; VIL-696 needs a name today.

---

## What the schedule is solving, and what it should solve

Still open, as of 17 Nov:

| Ticket | State | Due | What it actually is |
| --- | --- | --- | --- |
| VIL-658 | Todo, no owner | 29 Nov | The real launch gate. No Prod evidence attached. |
| VIL-696 | Todo, no owner | 24 Nov | Stop promoting a build that cannot answer a text. Caused by the 11 Nov outage. |
| VIL-560 | In progress | 26 Nov | Hostile email / calendar / page injection. Registration and Gmail are already in scope. |
| VIL-613 | Todo | 25 Nov | One link check, so a bare domain does not slip past the regexes. |
| VIL-541 | In progress since 2 Nov | 24 Nov | Friend-voice decisions still match `?` and word lists. Urgent, and already late. |
| VIL-692 | Todo | 21 Nov | `search_village` rejects `area: ""` and burns a coach step. |
| VIL-690 | Todo | 25 Nov | Some 1:1 writers ignore `users.proactive_language`. French and Chinese parents get English. |
| VIL-694 | Backlog | 27 Nov | Registration writer lies, on `EXPECTED_FAIL` on main. |
| VIL-689 | In progress | 20 Nov | Prove the group scenes on two real families. PR #1268 is this work. |
| VIL-681 | In progress | 19 Nov | Another unprompted text, 10–29 hours after a parent goes quiet. |
| VIL-675 | Backlog, launch:post | — | Registration success rate by city and vendor. |

**Cut or freeze**

- VIL-681. It adds unprompted texts in the same week the cadence flag is supposed to prove it will not spam. Ship it after a week of `live` with the daily cap in finding 5.
- New group-scene behaviour beyond the VIL-689 proof. Finding 8 is a privacy hole in the scenes that already exist.
- VIL-541's remaining regexes, if a given one does not change a send. It has been in progress for two weeks. It loses to findings 1–4.

**Do not cut**

- VIL-658. A waiver on the opt-out-during-outage row, the US health-line row, or the registration row is how launch week becomes the test.
- VIL-696. The 11 Nov outage is the precedent.
- VIL-560 and VIL-613. Both are "a stranger's content becomes a text or a click." That is worse than a blank-area search.
- VIL-690 for French. A Canada launch that answers a French parent in English is a broken product, not a polish item. It is still smaller than the credit and the checkout.

**Add, in this order**

1. Paid model capacity and a hard abort (finding 1). No public signup until this is done.
2. Stripe webhook applied in Prod, refund revocation, currency choice (findings 2 and 3). Promo flags stay off until then. A free launch does not need them.
3. Registration: no pre-open run, no burned season slot, no inline password without a retention letter (finding 4). Pull VIL-694 and VIL-675 into this, out of backlog.
4. Cadence kill switch and a daily cap (finding 5). Confirm the flag is actually `live`.
5. Remove the fixed STOP lines (finding 6) and fail closed on an unread stop (finding 7).
6. Consent on the multi-family aside (finding 8), then finish VIL-689.
7. VIL-696, then the VIL-658 journeys.

VIL-692 is a real coach-step bug and a small patch. Do it in a gap. It is not a launch theme.

## What held up under this pass

- Linq webhook HMAC and the five-minute replay window (`linq/signature.ts`). Inbound duplicates die on a unique provider-message index.
- A garbled model string is refused at the send seam and nothing is substituted (`linq/transport.ts` 71–86). Onboarding friend-voice failure sends nothing and pages.
- Stripe billing events that do apply are claimed in the same transaction as the tier write. An unknown price id does not grant a tier.
- During the promo window, checkout will not fall back to a list price (`prices.ts` 17–21). The CAD fallback is the **post-window Plus list** path only.
- Browser Use season claims use an advisory lock. The bug is the timing of the claim, not a race past the cap. Passwords are not in the task JSON. Sessions are `record: false`.
- Quiet hours follow the stored zone across DST. The bug is storing UTC.
- The outbound gate checks enrollment, the opt-out hold, watch consent, and quiet hours, in that order, and refuses to read the clock after a stop.

## How this was done

Read-only. `main` was fetched and matched `origin/main` at `4cd22e825`. Linear issues were read, not edited. No Prod env was read or written. Line numbers refer to that commit and will drift.
