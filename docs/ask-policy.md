# Ask policy: just do, tell after, ask first

**Status:** proposed 2026-11-20 (VIL-719). It runs behind `ASK_POLICY_TIERS_ENABLED`, which is off by default. The table is waiting for Noah's review and is not approved until he signs it.

- **Code:** `packages/tools-contracts/src/ask-policy.ts`.
- **Parity test:** `packages/tools-contracts/src/ask-policy-doc.test.ts` fails when the two tables below disagree with the code, so change both together.

For every kind of action Hale takes, code picks one of three tiers: Hale just does it, does it and tells the parent after, or asks first. The decision reads what the action is (its classes) plus structured facts that other code already set. It never reads the parent's words.

## The three tiers

| tier | what Hale owes the parent |
|---|---|
| `just_do` | Nothing more. It happens once the kind is earned, and it shows in the receipts. |
| `tell_after` | A text after it happens, written by the model from facts. If the model cannot write it, nothing is sent and #ops is paged. The action stands. |
| `ask_first` | A yes before it runs. It never runs on Hale's own say, whatever the streak or the opt-in says. |

## What a tier does not change

A tier never loosens an autonomy gate (CLAUDE.md rule 4). Whether Hale may *start* a kind on its own is still decided by these gates, in this order (`apps/worker/src/orchestrator/index.ts`):

1. reviewer approval
2. never-autonomous kinds
3. confidence
4. the teen cap
5. **ask first** (new)
6. the 7-day window
7. the per-parent 5-streak
8. the opt-in
9. cross-parent consent
10. the drafter's commitment reading
11. the execute lane
12. the delivered turn-on text

A just-do or tell-after kind passes every one of these before it runs on its own. The policy adds one gate and removes none.

A parent's yes to a draft is the override it always was: it runs a draft of any tier, ask first included.

## Classes and their tiers

An action takes the strictest tier of its classes.

| class | tier | the action |
|---|---|---|
| `read` | `just_do` | reads the family's own data or a public page |
| `remember` | `just_do` | writes only Hale's own notes about this family (memory, digest, routine) |
| `family_calendar` | `tell_after` | adds, moves or cancels an item on this family's own calendar |
| `parent_draft` | `tell_after` | prepares something the parent sends themselves; nothing leaves on Hale's word |
| `spend_money` | `ask_first` | moves money, or can incur a fee |
| `register_or_book` | `ask_first` | registers a child, enrols the family, or books or cancels an appointment |
| `contact_third_party` | `ask_first` | sends something to a person or organisation outside the family's own parents |
| `other_persons_info` | `ask_first` | reads, shares or changes another person's information |

## Every action kind

These are the kinds the executor knows (`ActionType`). A new kind fails to compile until it has a row in the code, and this test fails until it has a row here.

| kind | classes | tier | why |
|---|---|---|---|
| `send_email` | `contact_third_party` | `ask_first` | mail on the parent's behalf goes outside the family |
| `reply_to_email` | `contact_third_party` | `ask_first` | the same, in reply to a thread |
| `create_calendar_event` | `family_calendar`, `other_persons_info` | `ask_first` | the shared Google calendar commits the co-parent's schedule (cross-parent kind); unwired today |
| `update_calendar_event` | `family_calendar`, `other_persons_info` | `ask_first` | the same; unwired today |
| `place_supply_order` | `spend_money`, `contact_third_party` | `ask_first` | a merchant order |
| `cancel_supply_order` | `spend_money`, `contact_third_party` | `ask_first` | a cancellation can carry a fee |
| `fill_pdf_form` | `other_persons_info` | `ask_first` | a child's personal details written into a form |
| `submit_government_form` | `spend_money`, `contact_third_party`, `other_persons_info` | `ask_first` | a fee, an agency, a child's details |
| `book_clinic_portal` | `spend_money`, `register_or_book`, `contact_third_party` | `ask_first` | a fee, a commitment, the clinic |
| `cancel_clinic_appointment` | `register_or_book`, `contact_third_party` | `ask_first` | changes a commitment with the clinic |
| `share_photos_with_family` | `contact_third_party`, `other_persons_info` | `ask_first` | a child's image sent outward |
| `add_to_digest_only` | `remember` | `just_do` | Hale's own note in the family plan |
| `add_to_routine` | `remember` | `just_do` | Hale's own pin in the family plan |
| `calendar_add` | `family_calendar` | `tell_after` | Hale's family calendar, which both parents see |
| `calendar_move` | `family_calendar` | `tell_after` | the same |
| `calendar_cancel` | `family_calendar` | `tell_after` | the same |

The money classes match the kinds whose `REQUIRED_CHECKS` include `check_spending_cap`. Every kind with a recipient allowlist contacts a third party, and every cross-parent kind touches another person's information. The tests hold all three. A kind the table does not know is ask first.

## Facts that raise a tier

A fact can add a class. It can never remove one.

- **`commitsFamily`** adds `register_or_book`, so the action is ask first. It is the drafter's stored reading that a reply commits the family to an enrolment, a booking or a payment: `commits_parent_to_enrollment_booking_or_payment` on the payload. A misreading can only make Hale ask more.
- **Teen content is not a policy fact.** A teenager's private content, in a family with a teenager, is held by the teen cap (`teen_redaction`) before the policy is read. It is re-held on resume.

## The recorded yes

The recorded yes is the `action.approved_by_human` audit row. `recordHumanApproval` writes it in the same transaction that claims the event for execution.

With the flag on, three places hold an ask-first action that has no such row:
1. the orchestrator gate;
2. the resume re-gate, for a checkpoint an autonomous pass wrote;
3. the door in `executeAndRecord`, whatever path got there.

An actor id alone is not a yes. A refused action goes back to the parent as a draft and is audited `action.gated.ask_first`. The audit's detail names the classes, and `resumed` or `backstop` when one of those two places fired.

No streak earns an ask-first kind a grant: `grantAutonomyOnStreak` returns `ask_first`. A turn-on text for an ask-first kind is withheld, so no text promises that Hale will do it on its own.

## Tell after: the texts and their pages

Each text is written by the model. When it cannot be written, nothing is sent and #ops is paged, once per site per hour (`pageOps`, closed vocabulary). The action stands.

| text | skill | page site |
|---|---|---|
| the on-its-own text after an autonomous action | `autonomy-notice` | `autonomy_acted_unwritten` |
| the invite text to each parent after a calendar placement | `calendar-invite-voice`, `calendar-cancel-voice` | `calendar_invite_unwritten` |
| the calendar-write notice, behind `CALENDAR_WRITE_NOTICE_ENABLED` | `calendar-write-notice` | `calendar_write_notice_unwritten` |
| the team-schedule text after a change applied under a grant | `team-schedule-parent` | `team_schedule_unwritten` |
| the receipt after an email offer's yes placed the event | `offer-receipt` | `offer_receipt_unwritten` |
| the group plan's calendar report | `group-plan-calendar-report` | `group_plan_unwritten` (already) |
| the Gmail draft notice | `gmail-draft-notice` | the failed-turn page (already; no draft is written without its notice) |

`calendar_invite_unwritten` pages only when the model could not write the words (`client_unavailable`, `skill_unavailable`, `model_failed`). An unreadable zone or a summary that cannot be sent is a fact about the event, and is named on the invite leg instead.

## Just do

An execution's audit row carries `decision.askTier` while the flag is on. An action that ran as `just_do` owes no on-its-own text. The dispatch counts it as `justDo` and logs it. The flag is read per family when the dispatch runs, so turning it off makes those texts owed again.

## Lanes outside the executor

These run outside the executor, so this flag does not change them. Each already requires its own recorded yes, listed here so later work keeps to the same tiers.

| lane | classes | tier | the yes it requires today |
|---|---|---|---|
| one-shot sign-up (connector, Playwright, Browser Use) | `register_or_book`, `other_persons_info` | `ask_first` | the parent's reply, read as consent and bound to the ask, then an `authorized_signup_consents` row before the run |
| sign-up payment | `spend_money` | `ask_first` | the parent approves the exact total in Link, capped at the approved price |
| day-before plan run | `register_or_book`, `spend_money` | `ask_first` | the plan approval (consent row and `plan_approved` audit), re-checked before review and before payment |
| village introduction | `contact_third_party`, `other_persons_info` | `ask_first` | both families' `village_intro` consent rows |
| caregiver invite | `contact_third_party` | `ask_first` | a `caregiver_access_grant` consent row from the parent's reply, before the send |
| co-parent invite | `contact_third_party` | `ask_first` | a `co_parent_access_grant` consent row (see the gaps below) |
| multi-family group reads, shared free/busy | `other_persons_info` | `ask_first` | per-parent `multi_family_group` and free/busy consent rows |
| a coach calendar change (`propose_calendar_*`) | `family_calendar` | asks today (see below) | the parent's yes to the draft, which writes `action.approved_by_human` |
| an email offer's add (`email_alert_add`) | `family_calendar` | `tell_after` | the parent's yes to Hale's offer |
| a group plan copied to a household calendar | `family_calendar` | `tell_after` | the family's own words in the group |
| `prepare_gmail_draft` | `parent_draft` | `tell_after` | the parent's ask; nothing is sent |

The coach's other verbs:
- **Read and just do:** `lookup_week`, `read_email`, `find_activities`, `search_village`, `get_framework_guidance`, and the `list_*` verbs.
- **Remember and just do:** the promise, note and watch verbs, and `turn_off_autonomy`, which only tightens. `add_watch_target` also needs the parent's quoted agreement in the same turn.
- **Record an ask whose effect waits for a yes:** `offer_full_plan` and `offer_signup`.
- **Shape Hale's own reply and act on no one:** `react_to_parent_message`, `reply_as_voice_memo`, `share_experience_card`, `share_referral_link`.
- **Group verbs, at a member's request, with everyone they affect present:** `add_to_group_list`, `check_off_group_list_items`, `leave_group_chat`. The coach's reply in the group is the tell-after.

## Decided, not built here

- **A calendar change the parent asks for in the thread still asks.** It still goes propose, then the parent's yes, then execute. After it runs, the invite text and the calendar-write notice tell after, and both page when unwritten. Removing the question needs three things:
  - a coach-skill change, which means a coach-channel eval re-record;
  - its own execution entry point (not `executeApprovedAction` with a stand-in approver);
  - a recorded basis for the approval.

  The ready version, which loosens no gate: when the texting parent already holds a delivered grant for that calendar kind, a reviewer-approved coach draft runs through the same spine a yes uses, records `basis: instruction_under_grant`, and the coach tells after instead of asking. VIL-711 (restate before a calendar change) is the planned step.
- **Ask-first orchestrator drafts use today's surfaces:** the thread's standing questions, which the model words when the parent next writes, and the approvals page. No new proactive ask is sent.
- **For Noah: the Google leg of `calendar_*`.** On an autonomous pass with no actor, the Google write goes to the family's single scoped connection, whoever owns it, which can be the co-parent's own calendar (`apps/web/lib/integrations/google-calendar-placement.ts`). These kinds stay tell after, per the ticket. If that write counts as another person's information, the fix is a code-computed fact ("the Google target is not the grant holder's") that adds `other_persons_info`.

## Known gaps (already on main, not changed by this flag)

- A co-parent invite text can go out before its consent row is written.
- A plan run can use the other parent's saved city login and card unless `PLAN_CITY_LOGIN_OWNER_ENABLED`.
- The email to a provider after a plan options mismatch runs on the parent's model-read reply. It has no consent row and no reviewer.
- Team-schedule applies a calendar change through `executeApprovedAction` with the grant holder standing in as approver. With the flag on, that lane refuses any ask-first kind.
- A parent whose `send_email` grant predates the flag, and who was told Hale would email on its own, is not told it will ask again. Autonomous email cannot run today: the Gmail sender needs an actor.

## The switch

- **Flag:** `ASK_POLICY_TIERS_ENABLED`, catalog key `ask-policy-tiers`. On only for the exact value `true`, read per family through `askPolicyTiersEnabled(familyId)` (`@hale/worker/autonomy-gate`).
- **Off:** every path behaves as before, and nothing is stamped or paged.
- **Kill:** set `false` (or unset) and redeploy hale-web.
- **PostHog:** a `pnpm posthog:sync-flags` creates catalog flags at 100%. While the PostHog path is on, keep this key out of a sync, or set the env to `false`, until Barton says go.
- **New audit verb:** `action.gated.ask_first`.
- **New page sites:** the five `*_unwritten` sites in the table above.
