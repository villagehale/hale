import { type Database, schema } from '@hale/db';
import { and, desc, eq, gte, inArray } from 'drizzle-orm';
import { loadSmsChannelState } from '~/lib/channels/sms-consent-core';
import { WATCH_CONSENT_SCOPE } from '~/lib/channel/intake/watch-consent';
import { isWithinQuietHours } from '~/lib/loop/prefs';

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
export type ProactiveSendKind = 'nudge' | 'registration_sequence' | 'village_intro' | 'followup';

/** Why a proactive send is being held. Enum, never free text — it is counted (X1) and
 * logged, so it must be safe to emit and stable to aggregate on. */
export type ProactiveHoldReason =
  | 'not_enrolled'
  | 'no_watch_consent'
  | 'frequency_cap'
  | 'quiet_hours';

export type ProactiveSendVerdict = { allowed: true } | { allowed: false; reason: ProactiveHoldReason };

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
  'nudge' | 'registration_sequence' | 'village_intro' | 'followup'
> = {
  nudge: 'nudge',
  registration_sequence: 'registration_sequence',
  village_intro: 'village_intro',
  followup: 'followup',
};

export interface OutboundGatePorts {
  /** A live, verified, non-revoked channel for this parent. */
  channelEnrolled(parentUserId: string): Promise<boolean>;
  /** proactive_watch consent, as it stands NOW. */
  watchConsentGranted(parentUserId: string): Promise<boolean>;
  /** Proactive sends of this class that actually reached the FAMILY since `since`. */
  countProactiveSends(familyId: string, kind: ProactiveSendKind, since: Date): Promise<number>;
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
  if (request.urgent === true && URGENCY_ALLOWED[request.kind]) return { allowed: true };

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

  return { allowed: true };
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

/** Proactive sends of this class that actually LANDED for the family in the window.
 * Suppressions and failures do not consume a family's budget — only a message a
 * parent could have read. */
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
        inArray(schema.channelMessages.status, ['sent', 'delivered']),
      ),
    );
  return rows.length;
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
