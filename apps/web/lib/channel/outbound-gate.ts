import { type Database, schema } from '@hale/db';
import { and, desc, eq, gte, inArray } from 'drizzle-orm';
import { WATCH_CONSENT_SCOPE } from '~/lib/channel/intake/watch-consent';
import { SENT_STATUSES, isRealSendRow } from '~/lib/channel/ledger';
import { loadSmsChannelState, resolveSendablePhone } from '~/lib/channels/sms-consent-core';
import { isWithinQuietHours } from '~/lib/loop/prefs';
import { type OptOutForm, optOutPeriodStart } from './opt-out';
import { proactiveCadence } from './proactive/flag';
import { quietStartForPhone } from './proactive/quiet';

/**
 * F14 · THE OUTBOUND CHOKEPOINT (VIL-239 · M4 opens it).
 *
 * Hale texting a parent FIRST is a different act from Hale answering one, and it is
 * the act with the asymmetric downside: a reply nobody wanted is a nuisance, an
 * unsolicited text nobody wanted is a CASL problem and an uninstall. So there is
 * exactly ONE place that decides whether an unprompted message may leave the building,
 * and this is it.
 *
 * EVERY future proactive send class routes through `assertProactiveSendAllowed` —
 * add the kind to {@link ProactiveSendKind}, and it inherits the checks. A caller
 * that reaches a transport without an `allowed: true` verdict is a bug, not a shortcut.
 *
 * The checks run IN THIS ORDER, and the order is the design:
 *
 *   1. ENROLLED — the live `parent_channels` row (via loadSmsChannelState), never a
 *      consent-ledger read. `consent_records` is an append-only CASL ledger: after a
 *      STOP it still holds a granted=true row forever, so a query over it reads as
 *      "yes" for a parent who unsubscribed an hour ago. The live channel state is the
 *      only honest answer to "may we text this number right now".
 *   2. WATCH CONSENT — the parent said yes to being watched (rule #4). Read
 *      latest-row-wins, because the ledger carries BOTH withdrawal conventions
 *      (a revoked_at stamp, and an appended granted=false row).
 *   3. QUIET HOURS — the PARENT'S wall clock. A proactive message is never urgent by
 *      construction (an urgent thing is an alert, which is a different class), so
 *      there is no bypass here at all.
 *
 * First failure wins and the rest are never evaluated. That is not an optimization:
 * a family that pressed STOP must not have their timezone read, because after STOP
 * none of it is ours to look at.
 */

/**
 * Every class of message Hale may send UNPROMPTED. The union is the registry, so a new
 * class cannot be added without picking it a budget and an urgency stance below.
 *
 * `registration_sequence` (VIL-242 · M7) is the second class, and it is the first one
 * the parent SUBSCRIBED to: approving the shortlist Hale drafted for a specific
 * registration window is a request for a specific, finite ladder of messages about that
 * window. That single fact is what earns it both exemptions below.
 */
export type ProactiveSendKind =
  | 'nudge'
  | 'registration_sequence'
  | 'village_intro'
  | 'followup'
  | 'plan_check_in'
  | 'activity_followup'
  /**
   * VIL-337 · a course page a family asked Hale to watch stopped saying it was full.
   *
   * TWO CLASSES FOR ONE MESSAGE, and the split is the design. Whether an opening may
   * cross quiet hours is a decision the PARENT makes once, per watch, at arming time —
   * so it is a stored column that picks a class here, never an `urgent` flag a sweep
   * sets. {@link URGENCY_ALLOWED} is read per class precisely so a call site cannot
   * widen it, and `spot_open` is what a parent who said nothing gets.
   */
  | 'spot_open'
  | 'spot_open_instant'
  /**
   * A parenting email landed in a connected Gmail and Hale read it as a change the
   * parent has to act on — a cancelled class, a moved practice, a form due Friday.
   *
   * The parent CONNECTED the mailbox, which is consent to be watched, not consent to be
   * texted about whatever a classifier finds interesting: the volume is set by how much
   * mail arrives, so this class is the one where a classifier that drifts turns a
   * mailbox into a feed. Hence a real counter below rather than a null.
   */
  | 'email_alert'
  /**
   * An event appeared, moved or was cancelled on a connected Google Calendar.
   *
   * The sibling of `email_alert` and deliberately not the same class: this one needs no
   * classifier, because the calendar is the parent's OWN and every change on it is a
   * change they are entitled to hear about. What it shares is the failure mode — the
   * volume is set by how much the household's week moves, and a September that re-syncs
   * forty edits is the week where a text per edit is the uninstall.
   */
  | 'calendar_alert'
  /**
   * VIL-353 · "How did today go?" — the one question Hale asks every evening.
   *
   * THE HIGHEST-FREQUENCY PROACTIVE CLASS IN THE PRODUCT, and the only one whose whole
   * design is a rhythm rather than an event. Its real volume rail is the parent's own
   * cadence and the stop-answering ladder (channel/checkin/cadence.ts); the counter below
   * is the rail under a SWEEP that goes wrong, which for a class that runs nightly is the
   * one that would be felt fastest.
   */
  | 'evening_check_in'
  /**
   * The co-parent left, and the parent who STAYED is told once (VIL-355 follow-up).
   *
   * Unprompted by construction — the departing parent acted, the staying one did not —
   * so it belongs here rather than beside the departure receipt.
   */
  | 'co_parent_departed'
  /**
   * A booking email said the family is going somewhere with the children, and a week
   * before they go Hale texts a couple of things that are on there.
   *
   * THE LOWEST-FREQUENCY PROACTIVE CLASS IN THE PRODUCT, and the counter below is not the
   * bound — the bound is the trip, held by a claim keyed on the trip id. What the counter
   * is for is the OTHER failure: a detection pass that starts writing trips it should not
   * would otherwise produce a text per phantom trip, and one a week is the most that bug
   * can cost before it stops.
   */
  | 'travel_brief'
  /**
   * VIL-382 · a duty question in the co-parent group.
   *
   * The Sunday overview is folded into the weekly bubble and does not spend this
   * counter. What this counter bounds is a night-before confirmation or a
   * parent-asked "who's got pickup", each of which is its own group bubble. Two
   * a day matches the group ceiling (family-outbound's hard day max). The tighter
   * discretionary rail, one a day and three a week, is that group's bubble kind,
   * not a second number here.
   */
  | 'duty_ask'
  /**
   * VIL-131 · a kind just turned on, or turned back on after a switch-off.
   *
   * The bound is the grant, not a counter: one text per consent row, held by the
   * dedupe key. A counter could only drop the text that is what makes acting on
   * that kind allowed.
   */
  | 'autonomy_armed'
  /**
   * VIL-131 · Hale just did a kind without asking. One text per execution, same
   * reason the turn-on text is not a counter.
   */
  | 'autonomy_acted';

/** Why a proactive send is being held. Enum, never free text — it is counted (X1) and
 * logged, so it must be safe to emit and stable to aggregate on. */
export type ProactiveHoldReason =
  | 'not_enrolled'
  | 'no_watch_consent'
  | 'frequency_cap'
  | 'quiet_hours';

/**
 * WHICH SUPPRESSION THE LEDGER RECORDS, per hold — dispatch.ts's four statuses, chosen by
 * the gate's four reasons.
 *
 * HOISTED HERE (v5 travel) from two module-private copies. It was a six-line
 * `Record<ProactiveHoldReason, …>` in `integrations/email-alert.ts` and AGAIN in
 * `integrations/calendar-alert.ts`, which is already one more than the rule allows before
 * a shape is made unexpressible — and the travel sweep needed a third. It belongs beside
 * the union it is keyed on, in the direction the imports already run (outbound-gate.ts
 * imports `ledger`, never the other way), next to `acceptedStatus`'s mirror there.
 *
 * A `Record`, so a fifth hold reason cannot be added without choosing what its receipt
 * says.
 */
export type ProactiveHoldStatus =
  | 'suppressed_quiet_hours'
  | 'suppressed_cap'
  | 'suppressed_consent';

export function holdStatus(reason: ProactiveHoldReason): ProactiveHoldStatus {
  return HOLD_STATUS[reason];
}

const HOLD_STATUS: Record<ProactiveHoldReason, ProactiveHoldStatus> = {
  quiet_hours: 'suppressed_quiet_hours',
  frequency_cap: 'suppressed_cap',
  not_enrolled: 'suppressed_consent',
  no_watch_consent: 'suppressed_consent',
};

/**
 * `optOut` is the SECOND thing this gate decides, and it lives here for the same reason the
 * first one does: there is one place that knows an unprompted message is about to leave the
 * building, so there is one place that can answer a CASL question about it. Five callers
 * each answering it privately is five copies of the rule, and the three classes that once
 * appended nothing at all (village_intro, followup, plan_check_in) are what that looks like
 * when it goes wrong — an intro card can be the first proactive text a family ever gets.
 *
 * THERE IS NO "OMIT" VARIANT, deliberately (2026-08-14, after counsel). CASL wants the
 * unsubscribe in EVERY commercial electronic message; the only decision left is which FORM,
 * and typing it as a two-value union rather than a boolean is what stops a future edit
 * reintroducing an absent one. See lib/channel/opt-out.ts.
 *
 * It is DECIDED here and CLAIMED nowhere — the period is a fixed grid, so a send that is
 * composed and then discarded by a dedupe key has spent nothing and the next attempt
 * re-derives the same answer.
 */
export type ProactiveSendVerdict =
  | { allowed: true; optOut: OptOutForm }
  | { allowed: false; reason: ProactiveHoldReason };

const URGENCY_ALLOWED: Record<ProactiveSendKind, boolean> = {
  nudge: false,
  registration_sequence: true,
  // Nothing about an introduction is worthless an hour later. It waits seven days for
  // an answer; it can wait until 08:00.
  village_intro: false,
  // A question about something that already happened is the least urgent message Hale
  // sends. If it cannot go before 21:00 it goes tomorrow, or not at all.
  followup: false,
  // "How did the first few nights go?" is worth exactly as much tomorrow morning. It is
  // also the message most likely to be composed at a bad hour, since a plan sent at 9pm
  // comes due at 9pm — so the quiet-hours floor is doing real work here.
  plan_check_in: false,
  // A find is not worth less at 08:00 than at 22:00, and the parent asked about
  // September. Nothing on this path is time-critical, so the quiet-hours floor stands.
  activity_followup: false,
  // The default watch. A seat that opened at 02:14 is still open at 08:01 far more
  // often than not, and the sweep re-reads the page before it composes — so the held
  // observation costs a few hours of a race the parent was never going to win in their
  // sleep, and buys them not being woken.
  spot_open: false,
  // The parent asked, per watch, to be told the moment it happens. This is the class
  // that opt-in selects, and it is the only reason the exemption exists — a sweep
  // cannot reach it by setting a flag.
  spot_open_instant: true,
  // An email Hale read at 23:40 is an email the sender wrote hours ago and did not
  // think was worth a phone call. It keeps until 08:00.
  email_alert: false,
  // An event that moved at 23:50 is an event on tomorrow's calendar, which the parent
  // will read at 08:00 either way. Waking a household over a change they cannot act on
  // in the dark is the whole of what this floor exists to prevent.
  calendar_alert: false,
  // A question about a day that is over. There is no version of this message that is
  // worth waking a house for, and the 20:00 slot it is sent in sits an hour under the
  // floor anyway.
  evening_check_in: false,
  // Nothing here is worth less at 08:00. The seat is already gone, the week is already
  // theirs, and waking somebody at 23:00 to tell them their co-parent left is the
  // cruellest hour this message could pick.
  co_parent_departed: false,
  // A brief about next week is worth exactly as much at 08:00. There is no version of
  // "here is what is on in New York in seven days" that is worth waking a house for.
  travel_brief: false,
  // A confirmation of tomorrow's pickup keeps until morning. Nothing in this class
  // is worth a 23:00 text, and the night-before window already ends when quiet
  // hours start.
  duty_ask: false,
  // A kind turning on keeps until morning. Waking a house to say so is the opposite
  // of what the text is for, and execution waits until the text has gone out.
  autonomy_armed: false,
  autonomy_acted: false,
};

/**
 * The proactive quiet window, in the parent's local time. Deliberately NOT the
 * per-parent `loop_prefs` window: those prefs govern the loop's own templates and
 * default to a narrower band, while this is the floor under EVERY unprompted message
 * regardless of which surface produced it and whether the family has prefs at all.
 */
export const PROACTIVE_QUIET_HOURS = { start: '21:00', end: '08:00' } as const;

/**
 * The same window, as a bare check for the intake-adjacent PROACTIVE EXTRAS that cannot
 * route through {@link assertProactiveSendAllowed} — they run seconds after provisioning,
 * before watch consent can exist, so the full gate would refuse them always. The direct
 * reply to a parent's own inbound is exempt by design (a person texting at 23:00 gets
 * their answer); what consults this is the extra beside it: the welcome contact card and
 * the co-parent join's inviter ack, both observed leaving at 22:36 local around the gate
 * in the 2026-08-28 ads-week audit. One window, one reader — a second literal would
 * drift.
 */
export function inProactiveQuietHours(now: Date, timeZone: string): boolean {
  return isWithinQuietHours(now, timeZone, PROACTIVE_QUIET_HOURS.start, PROACTIVE_QUIET_HOURS.end);
}

/**
 * The `channel_messages.category` each proactive class is counted under. A class of
 * its own per kind, so one class's volume can never consume another's budget — with
 * ONE deliberate exception: the two watched-spot kinds share `spot_open`, because they
 * are the same message to the same family about the same event and only differ in
 * whether the parent asked to hear it at 2 a.m. Two categories there would be two
 * budgets, and the opt-in would silently double a household's volume.
 *
 * Exported for outbound-gate.test.ts: the mapping is the whole of "one budget, two
 * classes", and a gate that only the gate can read is a gate nobody can test.
 */
export const PROACTIVE_CATEGORY: Record<
  ProactiveSendKind,
  | 'nudge'
  | 'registration_sequence'
  | 'village_intro'
  | 'followup'
  | 'plan_check_in'
  | 'activity_followup'
  | 'spot_open'
  | 'email_alert'
  | 'calendar_alert'
  | 'evening_check_in'
  | 'co_parent_departed'
  | 'travel_brief'
  | 'duty_ask'
  | 'autonomy_armed'
  | 'autonomy_acted'
> = {
  nudge: 'nudge',
  registration_sequence: 'registration_sequence',
  village_intro: 'village_intro',
  followup: 'followup',
  plan_check_in: 'plan_check_in',
  activity_followup: 'activity_followup',
  spot_open: 'spot_open',
  spot_open_instant: 'spot_open',
  email_alert: 'email_alert',
  calendar_alert: 'calendar_alert',
  evening_check_in: 'evening_check_in',
  co_parent_departed: 'co_parent_departed',
  travel_brief: 'travel_brief',
  duty_ask: 'duty_ask',
  autonomy_armed: 'autonomy_armed',
  autonomy_acted: 'autonomy_acted',
};

export interface OutboundGatePorts {
  /** A live, verified, non-revoked channel for this parent. */
  channelEnrolled(parentUserId: string): Promise<boolean>;
  /** proactive_watch consent, as it stands NOW. */
  watchConsentGranted(parentUserId: string): Promise<boolean>;
  /** Proactive sends of this class that actually reached the FAMILY since `since`. */
  countProactiveSends(familyId: string, kind: ProactiveSendKind, since: Date): Promise<number>;
  /**
   * Whether ANY proactive class has reached THIS PARENT since `since`.
   *
   * Kind-blind, because the form is not a message class's. Per PARENT and NOT per family,
   * because the thing being tracked is a RECIPIENT'S first contact — and the five classes
   * text different people: a nudge goes to the primary parent, a registration leg to
   * whoever approved that shortlist, a plan check-in to whoever was coaching. Scoped per
   * family, a co-parent whose household was already contacted would never once get the
   * full line.
   */
  proactiveSentSince(parentUserId: string, since: Date): Promise<boolean>;
  parentTimeZone(parentUserId: string): Promise<string>;
  /**
   * VIL-226 · the parent's sendable number, read only while PROACTIVE_CADENCE is armed,
   * to start quiet hours at 20:00 for a Florida or Oklahoma line. Absent means the
   * 21:00 floor.
   */
  parentPhone?(parentUserId: string): Promise<string | null>;
}

export interface ProactiveSendRequest {
  familyId: string;
  parentUserId: string;
  kind: ProactiveSendKind;
  now: Date;
  /** This particular message is worthless if deferred, and its class is allowed to say
   * so ({@link URGENCY_ALLOWED}). Honoured only for such a class; ignored otherwise. */
  urgent?: boolean;
}

/**
 * Establish whether ONE unprompted message may be sent, right now, to this parent.
 *
 * Returns a verdict rather than throwing: all four holds are ordinary, expected states
 * that the caller must record differently (a cap hold is a healthy week; a
 * not-enrolled hold is a departed family), and turning routine policy into exception
 * control flow would make the common path the error path.
 */
export async function assertProactiveSendAllowed(
  request: ProactiveSendRequest,
  ports: OutboundGatePorts,
): Promise<ProactiveSendVerdict> {
  if (!(await ports.channelEnrolled(request.parentUserId))) {
    return { allowed: false, reason: 'not_enrolled' };
  }

  if (!(await ports.watchConsentGranted(request.parentUserId))) {
    return { allowed: false, reason: 'no_watch_consent' };
  }

  // An urgent leg does not read the clock: the answer could not change the verdict,
  // and the gate's standing discipline is to look at nothing it is not entitled to act on.
  if (request.urgent === true && URGENCY_ALLOWED[request.kind]) {
    return { allowed: true, optOut: await optOutForm(ports, request) };
  }

  const timeZone = await ports.parentTimeZone(request.parentUserId);
  const quietStart =
    proactiveCadence() !== 'off' && ports.parentPhone
      ? quietStartForPhone(await ports.parentPhone(request.parentUserId))
      : PROACTIVE_QUIET_HOURS.start;
  if (isWithinQuietHours(request.now, timeZone, quietStart, PROACTIVE_QUIET_HOURS.end)) {
    return { allowed: false, reason: 'quiet_hours' };
  }

  return { allowed: true, optOut: await optOutForm(ports, request) };
}

/**
 * WHICH FORM of the unsubscribe this message carries — never whether.
 *
 * FULL on the first proactive send of the current period, which for a recipient who has
 * never been texted first at all is their first proactive message ever. SHORT on everything
 * after it.
 *
 * IT FAILS TOWARD THE FULL LINE. A ledger read that throws resolves to `full`, because the
 * short form is the optimisation and the long one is the obligation: the worst case of
 * guessing wrong in this direction is a longer sentence, and in the other it is a
 * compliance gap nobody would see. Logged rather than swallowed, and never with the
 * recipient's id in the message.
 *
 * Read only after the four holds have passed — a held message is not a send, and the gate
 * looks at nothing it is not entitled to act on.
 */
async function optOutForm(
  ports: OutboundGatePorts,
  request: ProactiveSendRequest,
): Promise<OptOutForm> {
  try {
    const contacted = await ports.proactiveSentSince(
      request.parentUserId,
      optOutPeriodStart(request.now),
    );
    return contacted ? 'short' : 'full';
  } catch (err) {
    console.error(
      { err: err instanceof Error ? err.constructor.name : 'unknown' },
      'outbound gate: opt-out ledger read failed - falling back to the full line',
    );
    return 'full';
  }
}

/**
 * The two scopes a CO-PARENT's own express consent to be texted by Hale is recorded
 * under — one per door into the seat, and both written in the same transaction that
 * seats them:
 *
 *   · `sms_coparent_invite_reply` — they answered YES to the one invite Hale sent them
 *     (coparent/accept.ts);
 *   · `sms_join_origination` — they texted a forwarded join link themselves
 *     (join/invites.ts);
 *   · `linq_group_role_reply` — they said in the family's group that they are a parent,
 *     in their own words (linq/roster-seat.ts).
 *
 * Read rather than re-derived from the seat, because the seat is not the consent: a
 * departure appends a `granted=false` row for every live scope AND revokes the channel
 * (coparent/depart.ts), so both doors shut on the ledger's own terms.
 */
const CO_PARENT_SEATING_SCOPES = [
  'sms_coparent_invite_reply',
  'sms_join_origination',
  'linq_group_role_reply',
] as const;

/**
 * The parent's watch consent as it stands NOW: the newest row wins, and it only counts
 * as a grant when it is a grant that was never revoked.
 *
 * Both withdrawal conventions in this table are handled by that one rule — a
 * `revoked_at` stamp on the granting row, and an appended `granted=false` row that
 * supersedes it. A naive `granted = true` existence check reads "yes" under either.
 *
 * A SEATED CO-PARENT'S CONSENT IS THEIR SEATING CONSENT, and this is the one place that
 * had to learn it (audit 2026-09-17). `proactive_watch` has exactly one writer — the
 * intake watch-offer, answered by the parent who provisioned the household
 * (intake/watch-consent.ts, called from intake/machine.ts) — so a co-parent has no row
 * of that type and never will. Left alone, every unprompted message to them was held
 * `no_watch_consent` while the loop's weekly plan and event reminders reached them
 * anyway, which is two different answers to one question. What they DID give is express,
 * verbatim and on their own account: "Say yes and you'll see their whole week" is the
 * message they answered, and their yes is the row {@link CO_PARENT_SEATING_SCOPES}
 * names.
 *
 * THE FALLBACK IS ONLY FOR A PERSON WITH NO WATCH ROW AT ALL, and only inside a
 * household whose own watch answer is a live grant. A `proactive_watch` row that says
 * no still wins — for the person who wrote it and for the partner they share a family
 * with, because the radar is the household's and it is armed once.
 */
async function readWatchConsent(database: Database, parentUserId: string): Promise<boolean> {
  const [latest] = await database
    .select({
      granted: schema.consentRecords.granted,
      revokedAt: schema.consentRecords.revokedAt,
    })
    .from(schema.consentRecords)
    .where(
      and(
        eq(schema.consentRecords.userId, parentUserId),
        eq(schema.consentRecords.consentType, 'proactive_watch'),
        eq(schema.consentRecords.consentScope, WATCH_CONSENT_SCOPE),
      ),
    )
    .orderBy(desc(schema.consentRecords.grantedAt), desc(schema.consentRecords.id))
    .limit(1);
  if (latest) return latest.granted === true && latest.revokedAt === null;
  return readCoParentSeatingConsent(database, parentUserId);
}

/**
 * Their seating consent, read latest-row-wins across both doors — the same rule, and
 * the same two withdrawal conventions, as the watch row above.
 *
 * AND THE HOUSEHOLD'S OWN WATCH ANSWER, because a seat is not a second vote on it
 * (hard rule #1, default to the most restrictive reading; audit 2026-09-17 r1). The
 * unprompted lanes select families on `onboarding_stage = 'sms_active'`, which
 * `recordWatchConsent` sets on a DECLINE as well as on a grant, so the watch gate is
 * the only thing standing between "should I watch the registration dates at least?" -
 * "no" and the full radar. Left per-user, this fallback would have handed that
 * household the whole ladder the moment a co-parent was seated: the decline is the
 * primary parent's row, and the co-parent has none to overrule.
 *
 * `proactive_watch` has ONE writer (the intake offer, answered by the parent who
 * provisioned the household), so "the family's newest watch row" is that answer, and
 * reading it here is reading the household's own decision rather than inventing a
 * second one. A household nobody has asked yet is not a grant: the co-parent's seat
 * carries their consent to be TEXTED, and the radar waits for the same yes the primary
 * parent's does.
 */
async function readCoParentSeatingConsent(
  database: Database,
  parentUserId: string,
): Promise<boolean> {
  const [latest] = await database
    .select({
      granted: schema.consentRecords.granted,
      revokedAt: schema.consentRecords.revokedAt,
      familyId: schema.consentRecords.familyId,
    })
    .from(schema.consentRecords)
    .where(
      and(
        eq(schema.consentRecords.userId, parentUserId),
        eq(schema.consentRecords.consentType, 'sms_service_messages'),
        inArray(schema.consentRecords.consentScope, [...CO_PARENT_SEATING_SCOPES]),
      ),
    )
    .orderBy(desc(schema.consentRecords.grantedAt), desc(schema.consentRecords.id))
    .limit(1);
  if (!(latest?.granted === true && latest.revokedAt === null)) return false;
  // `consent_records.family_id` is nullable in general; every seating writer stamps it
  // (coparent/accept.ts, join/invites.ts, linq/roster-seat.ts), so a row without one did not come from a
  // door this fallback knows about and there is no household whose watch answer could
  // be read. Refusing is the only honest answer — guessing the family from a seat would
  // be this gate inventing the consent it exists to check.
  if (latest.familyId === null) return false;
  const seatedIn = latest.familyId;

  const [household] = await database
    .select({
      granted: schema.consentRecords.granted,
      revokedAt: schema.consentRecords.revokedAt,
    })
    .from(schema.consentRecords)
    .where(
      and(
        eq(schema.consentRecords.familyId, seatedIn),
        eq(schema.consentRecords.consentType, 'proactive_watch'),
      ),
    )
    .orderBy(desc(schema.consentRecords.grantedAt), desc(schema.consentRecords.id))
    .limit(1);
  return household?.granted === true && household.revokedAt === null;
}

/** Proactive sends of this class that actually WENT OUT for the family in the window.
 * Suppressions and failures do not consume a family's budget — only a message the
 * parent is going to read (a row still waiting for its receipt counts: it is already
 * on its way, and not counting it spends the budget twice). */
async function countFamilyProactiveSends(
  database: Database,
  familyId: string,
  kind: ProactiveSendKind,
  since: Date,
): Promise<number> {
  const rows = await database
    .select({ id: schema.channelMessages.id })
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.familyId, familyId),
        eq(schema.channelMessages.category, PROACTIVE_CATEGORY[kind]),
        eq(schema.channelMessages.direction, 'out'),
        gte(schema.channelMessages.createdAt, since),
        inArray(schema.channelMessages.status, [...SENT_STATUSES]),
        isRealSendRow(),
      ),
    );
  return rows.length;
}

/**
 * Has ANY proactive class landed for THIS PARENT since `since`? Same ledger and the same
 * "a message a parent could have read" rule as the per-class count, widened to every
 * proactive category and narrowed to one recipient — see the port's note on why.
 */
async function parentProactiveSentSince(
  database: Database,
  parentUserId: string,
  since: Date,
): Promise<boolean> {
  const [row] = await database
    .select({ id: schema.channelMessages.id })
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.parentUserId, parentUserId),
        inArray(schema.channelMessages.category, Object.values(PROACTIVE_CATEGORY)),
        eq(schema.channelMessages.direction, 'out'),
        gte(schema.channelMessages.createdAt, since),
        inArray(schema.channelMessages.status, [...SENT_STATUSES]),
        isRealSendRow(),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** The prod wiring: the gate stays a pure decision function, and this is the only
 * place it meets the database. */
export function buildOutboundGatePorts(database: Database): OutboundGatePorts {
  return {
    channelEnrolled: async (parentUserId) =>
      (await loadSmsChannelState(database, parentUserId)).enrolled,
    watchConsentGranted: (parentUserId) => readWatchConsent(database, parentUserId),
    countProactiveSends: (familyId, kind, since) =>
      countFamilyProactiveSends(database, familyId, kind, since),
    proactiveSentSince: (parentUserId, since) =>
      parentProactiveSentSince(database, parentUserId, since),
    parentTimeZone: async (parentUserId) => {
      const [row] = await database
        .select({ timezone: schema.users.timezone })
        .from(schema.users)
        .where(eq(schema.users.id, parentUserId))
        .limit(1);
      // users.timezone is NOT NULL with a default, so an absent row is the only way
      // here — and a missing parent is a caller bug, not a state to paper over.
      if (!row) throw new Error(`buildOutboundGatePorts: no users row for ${parentUserId}`);
      return row.timezone;
    },
    parentPhone: (parentUserId) => resolveSendablePhone(database, parentUserId),
  };
}
