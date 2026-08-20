import { type Database, schema } from '@hale/db';
import { and, desc, eq, gte, inArray } from 'drizzle-orm';
import { loadSmsChannelState } from '~/lib/channels/sms-consent-core';
import { SENT_STATUSES } from '~/lib/channel/ledger';
import { WATCH_CONSENT_SCOPE } from '~/lib/channel/intake/watch-consent';
import { isWithinQuietHours } from '~/lib/loop/prefs';
import { type OptOutForm, optOutPeriodStart } from './opt-out';

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
 * add the kind to {@link ProactiveSendKind} and its budget to {@link PROACTIVE_CAP},
 * and it inherits all four checks. A caller that reaches a transport without an
 * `allowed: true` verdict is a bug, not a shortcut.
 *
 * The four checks run IN THIS ORDER, and the order is the design:
 *
 *   1. ENROLLED — the live `parent_channels` row (via loadSmsChannelState), never a
 *      consent-ledger read. `consent_records` is an append-only CASL ledger: after a
 *      STOP it still holds a granted=true row forever, so a query over it reads as
 *      "yes" for a parent who unsubscribed an hour ago. The live channel state is the
 *      only honest answer to "may we text this number right now".
 *   2. WATCH CONSENT — the parent said yes to being watched (rule #4). Read
 *      latest-row-wins, because the ledger carries BOTH withdrawal conventions
 *      (a revoked_at stamp, and an appended granted=false row).
 *   3. FREQUENCY CAP — per FAMILY, not per parent: a household is one audience, and
 *      counting per parent would let a co-parent signup silently double the volume.
 *   4. QUIET HOURS — the PARENT'S wall clock. A proactive message is never urgent by
 *      construction (an urgent thing is an alert, which is a different class), so
 *      there is no bypass here at all.
 *
 * First failure wins and the rest are never evaluated. That is not an optimization:
 * a family that pressed STOP must not have their message volume counted or their
 * timezone read, because after STOP none of it is ours to look at.
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
  | 'plan_check_in';

/** Why a proactive send is being held. Enum, never free text — it is counted (X1) and
 * logged, so it must be safe to emit and stable to aggregate on. */
export type ProactiveHoldReason =
  | 'not_enrolled'
  | 'no_watch_consent'
  | 'frequency_cap'
  | 'quiet_hours';

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

/**
 * The volume budget per class, per FAMILY — or `null` where the class is bounded by
 * something better than a counter.
 *
 * A nudge is the "Hale noticed something" message: discretionary, open-ended, and
 * capable of becoming a feed, so one a week is the most a household can receive and
 * still read it as a signal.
 *
 * A registration sequence is neither. Its length is fixed by the window it serves (a
 * heads-up, a battle plan, a go, one check-in, at most two waitlist guards) and every
 * leg exists because the parent approved a shortlist for that specific date. A counter
 * over it would not be a safety rail, it would be a bug: a family who approved two
 * windows in one week would silently lose the second window's 6:15 a.m. message — the
 * single most valuable thing this product sends — to a budget designed for suggestions.
 * The bound is the ladder; `null` says so explicitly rather than by omission (`Record`
 * still forces every class to make a choice).
 */
export const PROACTIVE_CAP: Record<
  ProactiveSendKind,
  { max: number; windowHours: number } | null
> = {
  nudge: { max: 1, windowHours: 24 * 7 },
  registration_sequence: null,
  // Village intros v1. The intro loop is bounded by its own state machine — one ask
  // ever, one card per side per pairing, one close — so in a healthy week a household
  // sees at most three. The counter is not that bound restated; it is the rail under a
  // MATCHER that goes wrong. A pairing bug is the one failure here that scales: it
  // would text every family in an FSA about each other, unprompted, about other
  // people's children. Three a week is the most that bug can cost before it stops.
  village_intro: { max: 3, windowHours: 24 * 7 },
  // The follow-up ask. ONE PER FAMILY PER DAY, and this entry IS that rule rather than a
  // counter guarding it: the gate already answers "at most N of this class per family per
  // window", which is exactly what the rail says, so expressing it anywhere else would be
  // a second implementation of a policy that already has one.
  //
  // It also settles precedence for free. Both kinds of follow-up are due on the same
  // sweep tick sometimes, and the intro one runs first — so its send consumes the day's
  // single slot and the activity ask is held here, honestly, as `frequency_cap`, and
  // comes back tomorrow. No tie-break code, no priority field.
  followup: { max: 1, windowHours: 24 },
  // The three-day follow-up on a full coaching plan. Like the registration ladder it is
  // SUBSCRIBED — the parent asked a question, was offered the plan, and said yes — but
  // unlike that ladder its volume is a function of how much COACHING a family does, and
  // a household that asks four questions in a week is exactly the household that must
  // not get four unprompted follow-ups. Two is the rail: enough that two live plans can
  // both be followed up, few enough that a bug in the sweep stops after a nuisance.
  plan_check_in: { max: 2, windowHours: 24 * 7 },
};

/**
 * Which classes may claim `urgent` and cross quiet hours.
 *
 * The quiet-hours rule reads "a proactive message is never urgent by construction",
 * and that holds for everything Hale decides to send on its own. A registration
 * sequence is the exception the sentence anticipated: the parent asked for a message
 * timed to a municipal clock they do not control, and the two legs that claim urgency
 * are WORTHLESS late — a battle plan deferred to 08:00 arrives after a 06:30 open, and
 * a 15-minute warning that waits never fires at all.
 *
 * Fail-closed and per CLASS, never per caller: a `nudge` that sets `urgent` is still
 * held, so the exemption cannot be widened by a flag at a call site.
 */
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
};

/**
 * The proactive quiet window, in the parent's local time. Deliberately NOT the
 * per-parent `loop_prefs` window: those prefs govern the loop's own templates and
 * default to a narrower band, while this is the floor under EVERY unprompted message
 * regardless of which surface produced it and whether the family has prefs at all.
 */
export const PROACTIVE_QUIET_HOURS = { start: '21:00', end: '08:00' } as const;

/** The `channel_messages.category` each proactive class is counted under. A class of
 * its own per kind, so one class's volume can never consume another's budget. */
const PROACTIVE_CATEGORY: Record<
  ProactiveSendKind,
  'nudge' | 'registration_sequence' | 'village_intro' | 'followup' | 'plan_check_in'
> = {
  nudge: 'nudge',
  registration_sequence: 'registration_sequence',
  village_intro: 'village_intro',
  followup: 'followup',
  plan_check_in: 'plan_check_in',
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

  const cap = PROACTIVE_CAP[request.kind];
  if (cap !== null) {
    const since = new Date(request.now.getTime() - cap.windowHours * 3_600_000);
    if ((await ports.countProactiveSends(request.familyId, request.kind, since)) >= cap.max) {
      return { allowed: false, reason: 'frequency_cap' };
    }
  }

  // An uncapped class does not read the ledger at all, and an urgent leg does not read
  // the clock: in both cases the answer could not change the verdict, and the gate's
  // standing discipline is to look at nothing it is not entitled to act on.
  if (request.urgent === true && URGENCY_ALLOWED[request.kind]) {
    return { allowed: true, optOut: await optOutForm(ports, request) };
  }

  const timeZone = await ports.parentTimeZone(request.parentUserId);
  if (
    isWithinQuietHours(
      request.now,
      timeZone,
      PROACTIVE_QUIET_HOURS.start,
      PROACTIVE_QUIET_HOURS.end,
    )
  ) {
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
 * The parent's proactive_watch consent as it stands NOW: the newest row wins, and it
 * only counts as a grant when it is a grant that was never revoked.
 *
 * Both withdrawal conventions in this table are handled by that one rule — a
 * `revoked_at` stamp on the granting row, and an appended `granted=false` row that
 * supersedes it. A naive `granted = true` existence check reads "yes" under either.
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
    .orderBy(desc(schema.consentRecords.grantedAt))
    .limit(1);
  return latest?.granted === true && latest.revokedAt === null;
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
  };
}
