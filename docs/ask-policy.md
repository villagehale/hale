# Ask policy: just do, tell after, ask first

**Status:** the tables below were reviewed against the code on 2026-11-21 (VIL-719). Barton approves them when he merges. The policy runs behind `ASK_POLICY_TIERS_ENABLED`, which is off by default.

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
13. **whose Google calendar a calendar kind would write to** (new, at the executor door)

A just-do or tell-after kind passes every one of these before it runs on its own. The policy adds two gates and removes none.

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
- **`writesAnotherParentsCalendar`** adds `other_persons_info`, so the action is ask first. With no approving parent, the Google leg of `calendar_add`, `calendar_move` or `calendar_cancel` writes to the family's one scoped connection, or to the connection already holding the event. If that calendar's owner does not personally hold the kind (their own streak and live grant), the action waits for a yes. A connection that names no owner counts as someone else's, and so does a read that fails: the action waits for a yes and the audit row carries `calendarOwnerUnread`. The door reads the owner through `writeTarget`, the same flag read and connection choice the write uses, on every pass with no approving parent. After a yes, an add goes to the approver's own calendar. A move or cancel follows the calendar that holds the event, whoever owns it, so one parent's yes can rewrite the event on the other parent's own Google calendar without that parent's yes (see the gaps below).
- **Teen content is not a policy fact.** A teenager's private content, in a family with a teenager, is held by the teen cap (`teen_redaction`) before the policy is read. It is re-held on resume.

## The recorded yes

The recorded yes is the `action.approved_by_human` audit row. `recordHumanApproval` writes it in the same transaction that claims the event for execution.

With the flag on, three places hold an ask-first action that has no such row:
1. the orchestrator gate;
2. the resume re-gate, for a checkpoint an autonomous pass wrote;
3. the door in `executeAndRecord`, for the autonomous pass, a resume, and a tap on an autonomous checkpoint.

The door cannot refuse a lane that calls `executeApprovedAction`: that function writes the `action.approved_by_human` row itself, from the `approvedBy` it was given. **Each lane calling it must enforce the tier itself.** The human-approval job runs on the parent's yes, and team-schedule refuses ask-first kinds in `calendarKindAutonomous`. A refused action goes back to the parent as a draft and is audited `action.gated.ask_first`. The audit's detail names the classes, and `resumed` or `backstop` when one of those two places fired. A hold for another parent's Google calendar is made at the door and names `writesAnotherParentsCalendar` instead of `backstop`.

No streak earns an ask-first kind a grant: `grantAutonomyOnStreak` returns `ask_first`. A turn-on text for an ask-first kind is withheld, so no text promises that Hale will do it on its own.

## Tell after: the texts and their pages

Each text is written by the model. When it cannot be written, nothing is sent and #ops is paged, once per site per hour (`pageOps`, closed vocabulary). The action stands. A writer that could not run at all, because its skill will not load or its model client cannot be built, counts as unwritten.

| text | skill | page site |
|---|---|---|
| the on-its-own text after an autonomous action | `autonomy-notice` | `autonomy_acted_unwritten` |
| the invite text to each parent after a calendar placement | `calendar-invite-voice`, `calendar-cancel-voice` | `calendar_invite_unwritten` |
| the calendar-write notice, behind `CALENDAR_WRITE_NOTICE_ENABLED` | `calendar-write-notice` | `calendar_write_notice_unwritten` |
| the team-schedule text after a change applied under a grant | `team-schedule-parent` | `team_schedule_unwritten` |
| the driver's text after that change | `team-schedule-driver` | `team_schedule_driver_unwritten` |
| the receipt after an email offer's yes placed the event | `offer-receipt` | `offer_receipt_unwritten` |
| the group plan's calendar report | `group-plan-calendar-report` | `group_plan_unwritten` (already) |
| the Gmail draft notice | `gmail-draft-notice` | the failed-turn page (already; no draft is written without its notice) |

A team-schedule change the executor refused (outside the action window), failed or threw on did not land, so nobody is told it moved and no reminder moves. The action leaves the parent's yes list as `needs_human`, because they were never asked about it (a refused one writes `team_schedule_change_not_run`). A failed or thrown run pages #ops (`team_schedule_not_applied`). The email then goes through the normal email notice and its quiet-hours hold, so the parent still hears what the email said.

An ask is off the yes list until Linq has taken it: the draft is written as `needs_human` and promoted to `drafted_for_approval` only after the send is accepted, so a throw or a crash at any point leaves it unapprovable, and a later plain yes cannot approve a change the parent never heard about. A database error on the ledger after Linq took the text is logged and the ask stands: it is not recorded as a failed send. If the promotion itself fails after Linq took the text, the ledger and thread are still written, the draft stays `needs_human`, a `team_schedule_change_not_run` row is written, and #ops is paged (`team_schedule_ask_unbound`), because the parent's yes has nothing to approve. After a gate hold, the email goes through the normal notice, and its quiet-hours hold runs this lane again later, which asks again. After a failed send, a missing number or chat, or a send another run already made, that email's send key is spent, so no second text goes. The `team_schedule_change_not_run` row belongs to the parent whose inbox the email came from: it is off History and the family export, and in that parent's own copy.

`calendar_invite_unwritten` pages for every deferral that left a parent without the text: `client_unavailable`, `skill_unavailable`, `model_failed`, `gate_exhausted` (every draft refused), `time_unjudged`, and a summary held before the model call (`summary_too_long`, `summary_carries_destination`). The time judge failing and an unreadable zone share `time_unjudged` on the invite leg, so both page. Every invite sender that follows a calendar change is wrapped: the drain, the nudge cron's cancel re-drive, the group common-time plan, and an undo's withdrawal.

## Just do

An execution's audit row carries `decision.askTier` while the flag is on. An action that ran as `just_do` owes no on-its-own text. The dispatch counts it as `justDo` and logs it. The flag is read when the dispatch runs, so turning it off makes those texts owed again.

## Lanes outside the executor

These run outside the executor. The flag changes two of them: the provider email and the team-schedule driver's text. A co-parent or caregiver invite keeps main's path in this change, and its gaps are tracked in VIL-759. Each of the others already requires its own recorded yes, listed here so later work keeps to the same tiers.

| lane | classes | tier | the yes it requires today |
|---|---|---|---|
| one-shot sign-up (connector, Playwright, Browser Use) | `register_or_book`, `other_persons_info` | `ask_first` | the parent's reply, read as consent and bound to the ask, then an `authorized_signup_consents` row before the run |
| sign-up payment | `spend_money` | `ask_first` | the parent approves the exact total in Link, capped at the approved price |
| day-before plan run | `register_or_book`, `spend_money` | `ask_first` | the plan approval (consent row and `plan_approved` audit), re-checked before review and before payment |
| email to a provider after a plan's options did not match | `contact_third_party` | `ask_first` | the parent's model-read reply, bound to the ask. With the flag on, a `provider_email_yes` audit row naming the parent and their message is written first, and no email leaves without it |
| village introduction | `contact_third_party`, `other_persons_info` | `ask_first` | both families' `village_intro` consent rows |
| caregiver invite | `contact_third_party` | `ask_first` | a `caregiver_access_grant` consent row from the parent's reply, before the send |
| co-parent invite | `contact_third_party` | `ask_first` | a `co_parent_access_grant` consent row. This change leaves the path as it is on main, including the order of the text and that row on the SMS door. Its gaps are tracked in VIL-759 |
| carpool or duty driver's text after a team-schedule change | `contact_third_party` when the driver is not one of the family's own parents | `ask_first` for that driver, `tell_after` for the family's own parent | with the flag on, a grant does not cover it: the whole change waits for the parent's yes to the draft (`action.approved_by_human`), and the driver is texted after that yes. The ask does not yet name the driver, because that changes the writer's facts and needs a paid eval |
| multi-family group reads, shared free/busy | `other_persons_info` | `ask_first` | per-parent `multi_family_group` and free/busy consent rows |
| a coach calendar change (`propose_calendar_*`) | `family_calendar` | asks today (not built as tell after, see below) | the parent's yes to the draft, which writes `action.approved_by_human` |
| an email offer's add (`email_alert_add`) | `family_calendar` | `tell_after` | the parent's yes to Hale's offer |
| a group plan copied to a household calendar | `family_calendar` | `tell_after` | the family's own words in the group |
| `prepare_gmail_draft` | `parent_draft` | `tell_after` | the parent's ask; nothing is sent |

The coach's other verbs:
- **Read and just do:** `lookup_week`, `read_email`, `find_activities`, `search_village`, `get_framework_guidance`, and the `list_*` verbs.
- **Remember and just do:** the promise, note and watch verbs, and `turn_off_autonomy`, which only tightens. `add_watch_target` also needs the parent's quoted agreement in the same turn.
- **Record an ask whose effect waits for a yes:** `offer_full_plan` and `offer_signup`.
- **Shape Hale's own reply and act on no one:** `react_to_parent_message`, `reply_as_voice_memo`, `share_experience_card`, `share_referral_link`.
- **Group verbs, at a member's request, with everyone they affect present:** `add_to_group_list`, `check_off_group_list_items`, `leave_group_chat`. The coach's reply in the group is the tell-after.

## Not built: tell after for a calendar change the parent asks for

**VIL-719 names this flow as tell after, and it is not built.** A calendar change the parent asks for in the thread still goes propose, then their yes, then execute. After it runs, the invite text and the calendar-write notice tell after, and both page when unwritten. Barton has not ruled on removing the question, so nothing here treats it as decided. Two notes pull different ways: VIL-719 (11-19) lists this flow as tell after, and VIL-711 (a post-launch idea, 11-18) says Hale "acts only after the parent confirms in their own words" before it changes a calendar.

Removing the question is more than a skill edit. The yes is what stops outside content from moving a calendar today, so the change needs all of these:

- **A read of the parent's own words that outside content cannot reach.** A search result, a mail-derived title or a photo can sit in the coach's turn, and the coach's call to `propose_calendar_*` is the only sign of intent.
- **One run per instruction.** A deferred or timed-out turn is run again, and a second add would be a second event.
- **The failed-turn path.** Its receipt says a draft is waiting, which would be false for a change that already ran.
- **The claim gate.** It checks a reply against the family's rows, and the new row does not exist yet when the reply is written.
- **A paid coach-channel eval recording**, which needs Barton's OK for this PR.

If he wants it, the version that loosens no gate is: when the texting parent already holds a delivered grant for that calendar kind, a reviewer-approved coach draft runs through the same spine a yes uses, records `basis: instruction_under_grant`, and the coach tells after instead of asking.

## What can fire today

With the flag on, these lanes have a real trigger:

- **The ask-first hold**, on what the classifier produces: its prompt names `reply_to_email`, `place_supply_order` and `share_photos_with_family` for an autonomous action.
- **The tell-after texts**, after a parent's yes on a coach calendar draft, and after a team-schedule change applied under a grant.
- **The provider-email yes**, when a parent answers a plan's options mismatch by asking Hale to email the provider.

These have no production trigger today, so they are ready but will not fire:

- **An autonomous calendar action, and with it the Google-owner hold.** The classifier's prompt routes schedule notices to surface only. Coach and team-schedule calendar actions carry a parent as the actor, an email offer's add runs outside the executor, and the owner is read only when no parent is the actor.
- **An autonomous just-do action.** `add_to_routine` reaches the autonomous pass only through `acceptVillageCandidate`, which has no production caller, and the classifier's prompt names neither just-do kind.

Ask-first orchestrator drafts use today's surfaces: the thread's standing questions, which the model words when the parent next writes, and the approvals page. No new proactive ask is sent.

## Known gaps (already on main, not changed by this flag)

- A parent's yes on a move or cancel rewrites the event on the Google calendar that holds it, including the other parent's own, and that parent is not asked (`selectGcalConnection`). It needs Google writes armed for the approving parent. The alternatives are asking the calendar's owner, or skipping the Google write and leaving the old time on their calendar. Barton has not ruled on this.
- A plan run can use the other parent's saved city login and card unless `PLAN_CITY_LOGIN_OWNER_ENABLED`.
- The email to a provider after a plan options mismatch has no reviewer, its body is assembled in code, and with the flag off it has no recorded yes.
- Team-schedule applies a calendar change through `executeApprovedAction` with the grant holder standing in as approver. With the flag on, that lane refuses any ask-first kind and any change that would text a driver outside the family's own parents. It binds no Google port, so it never writes to anyone's Google calendar.
- Across the flag flip, a parent's tap can land on an autonomous checkpoint of an ask-first kind. That tap writes no `action.approved_by_human` row, so the door hands the action back as a draft. The tap's job id is the action id, so a second tap is ignored until pg-boss archives the finished job. An approval that lands outside the action window has the same limit today.
- A parent whose `send_email` grant predates the flag, and who was told Hale would email on its own, is not told it will ask again. Autonomous email cannot run today: the Gmail sender needs an actor.

## The switch

- **Flag:** `ASK_POLICY_TIERS_ENABLED`, catalog key `ask-policy-tiers`. On only for the exact value `true`, read through `askPolicyTiersEnabled(familyId)` (`@hale/worker/autonomy-gate`). Env-only, so it is on for every family or none.
- **Off:** every path behaves as before, and nothing is stamped or paged.
- **Kill:** unset it, or set anything except exact `true`, and redeploy hale-web.
- **PostHog:** env-only (VIL-755). PostHog is never read for it and `pnpm posthog:sync-flags` never creates it.
- **New audit verbs:** `action.gated.ask_first`, and `team_schedule_change_not_run` for a change a grant could not land or an asked draft that could not join the yes list.
- **New page sites:** the six `*_unwritten` sites this change adds to the table above (`group_plan_unwritten` and the failed-turn page were already there), `team_schedule_not_applied` for a failed run, and `team_schedule_ask_unbound` for an ask Linq took whose draft could not join the yes list.
