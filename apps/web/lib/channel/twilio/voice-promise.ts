import type { Database } from '@hale/db';
import type { ActivityPromise } from '~/lib/channel/activity/commitment';
import {
  type ActivityPromisePorts,
  defaultActivityPromisePorts,
  recordActivityPromise,
} from '~/lib/channel/activity/commitment';
import { deidentifyActivityQuery } from '~/lib/channel/activity/deidentify';
import type { BoundActivityReader } from '~/lib/channel/activity/reader';
import { extractStateClaims } from '~/lib/channel/reconcile/claims';

/**
 * VIL-313 · A PROMISE HALE SAID OUT LOUD IS A ROW — the open-loops ledger, reached from
 * a call.
 *
 * THE INVARIANT: if a caller heard Hale say it would text them, something is on the hook
 * to text them.
 *
 * WHAT IT COST TO NOT HAVE THIS. Founder call CA170c1fb0, 2026-08-26, 03:11-03:14Z. Hale
 * said "Once I've got the details locked down I'll text you" and, a minute later, "I'll
 * send you the Three-Day Potty breakdown after this call" — the parent said yes to the
 * second one out loud. `agent_commitments` got ZERO rows for that call and no text ever
 * followed. The debt existed only as audio nobody kept and two `messages` rows nothing
 * queries.
 *
 * WHY THE SPOKEN TEXT AND NOT A TOOL CALL. The SMS lane mints its activity promise from
 * `promise_activity_followup` — the model registers the debt beside the sentence, and
 * the reconcile gate refuses the sentence when it did not (reconcile/gate.ts). A call
 * cannot be refused: the words are already out of the speaker by the time anything could
 * judge them, there is no second attempt, and cutting a sentence out of a reply is not a
 * move available to a thing that has already been heard. So the direction reverses. Over
 * SMS an unbacked promise is REFUSED; on a call it is RECORDED — the sentence is taken as
 * true and a row is written to make it true. Same primitive, same file of promise-shapes
 * (reconcile/claims.ts), opposite remedy, and it is the surface's own asymmetry rather
 * than two opinions about what a promise is.
 *
 * THE TOOL IS STILL THE BETTER SUBJECT. When the turn reached for the search verb, the
 * model handed a de-identified subject that already cleared phase 0 and says what the
 * promise is ABOUT. {@link collect} keeps it; the caller's own utterance is the fallback,
 * and it goes through the same phase-0 gate before it can be stored — the sweep hands
 * this string to `web_search` a couple of hours later with no model between it and the
 * border (rule #1).
 */

/**
 * How long Hale has, after a call, before the promise is late.
 *
 * TWO HOURS, and it is shorter than the SMS lane's twenty-four
 * ({@link ACTIVITY_FOLLOWUP_DUE_HOURS}) for a reason about what the parent was told
 * rather than about how long a search takes. "I'll text you after this call" has a
 * deadline in it that "I'll come back to you" does not: the caller hangs up expecting
 * their phone to buzz, and a day later is not after the call. Two hours is the first
 * hourly nudge tick a caller could plausibly still be waiting through, and it puts the
 * follow-up inside the same evening rather than the next one.
 */
export const SPOKEN_PROMISE_DUE_HOURS = 2;

/**
 * What became of the promise a caller heard. Named on every branch (rule #11): the whole
 * defect this module closes is a promise that produced nothing and reported nothing, so
 * "we did not write a row" may never be indistinguishable from "there was nothing to
 * write".
 */
export type SpokenPromiseOutcome =
  | { status: 'recorded'; commitmentId: string }
  /** Hale promised nothing this turn. The ordinary answer, and not a failure. */
  | { status: 'no_promise' }
  | {
      status: 'not_recorded';
      reason:
        | 'no_ledger_row'
        | 'write_failed'
        | 'already_open'
        /** The subject could not cross the border, so nothing may be stored to search on
         * later. The parent still heard the promise — this is the loud case (rule #1). */
        | 'subject_refused';
    };

/** The claim kinds a SPOKEN promise may mint. One, deliberately: `registration_watch`
 * needs a matched municipal window before a row can be written honestly (reconcile.ts),
 * and `scheduled_event` and `self_referential` are assertions rather than debts. */
function spokenDebt(spoken: string): boolean {
  return extractStateClaims(spoken).some((claim) => claim.kind === 'activity_followup');
}

export interface VoicePromisePorts extends ActivityPromisePorts {
  reader: Pick<BoundActivityReader, 'householdNames'>;
  log: Pick<Console, 'error' | 'info'>;
}

export interface VoicePromiseRecorder {
  /**
   * The subject the turn's search verb registered, if it reached for one. NOT a no-op
   * collector (rule #11): the coach tools only register the web verbs when something is
   * listening for the promise they can produce, and what this listener does with it is
   * supply the subject the ledger row is searched on.
   */
  collect(promise: ActivityPromise): void;
  /**
   * Judge what the caller actually HEARD, and write the row against the message that
   * carried it.
   *
   * `heard` rather than what was composed: a caller who talked over Hale halfway through
   * the promise was not promised anything, and the session already truncates to the
   * spoken prefix before it records (relay-session.ts).
   */
  record(input: {
    familyId: string;
    /** What Hale said out loud, truncated to what the caller heard. */
    heard: string;
    /** What the caller asked — the fallback subject when no verb registered one. */
    asked: string;
    /** The `channel_messages` row for the spoken turn. Null means the turn was never
     * written down, and a promise with nothing to point at is not recorded. */
    channelMessageId: string | null;
    now: Date;
  }): Promise<SpokenPromiseOutcome>;
}

export function voicePromiseRecorder(
  database: Database,
  ports: VoicePromisePorts,
): VoicePromiseRecorder {
  /** THIS CALL's last registered subject. Per socket, and turns run one at a time
   * (relay-session's `pending`), so it can only ever describe the turn being recorded. */
  let registered: ActivityPromise | null = null;

  return {
    collect(promise) {
      registered = promise;
    },

    async record(input) {
      const promised = registered;
      // Cleared whatever happens next: a promise carried into the next turn would attach
      // this turn's subject to a sentence that never made it.
      registered = null;

      if (!promised && !spokenDebt(input.heard)) return { status: 'no_promise' };

      // THE VERB'S SUBJECT FIRST — it already cleared phase 0 inside the tool and it says
      // what Hale is coming back about. The utterance is the fallback, and it is the only
      // thing available on the shape that produced the defect: a model that says the
      // sentence and calls nothing.
      const subject = promised?.subject ?? input.asked;
      const householdNames = await ports.reader.householdNames(input.familyId);
      const deidentified = deidentifyActivityQuery({
        subject,
        municipality: null,
        stage: null,
        householdNames,
      });
      if (!deidentified.ok) {
        // The parent was promised a text and the subject cannot be stored to search on.
        // Never the subject itself — the refusal exists because that string held
        // something (rule #1).
        ports.log.error(
          { familyId: input.familyId, refusal: deidentified.refusal },
          'voice promise: Hale promised out loud and the subject cannot be searched - nothing will come back',
        );
        return { status: 'not_recorded', reason: 'subject_refused' };
      }

      const outcome = await recordActivityPromise(
        database,
        {
          familyId: input.familyId,
          promise: { subject: deidentified.query.subject, childId: promised?.childId ?? null },
          channelMessageId: input.channelMessageId,
          dueInHours: SPOKEN_PROMISE_DUE_HOURS,
          now: input.now,
        },
        ports,
      );
      if (outcome.status === 'recorded') {
        ports.log.info(
          { familyId: input.familyId, fromVerb: promised !== null },
          'voice promise: a promise Hale spoke is now a row the sweep owes',
        );
      }
      return outcome;
    },
  };
}

export function defaultVoicePromisePorts(
  reader: Pick<BoundActivityReader, 'householdNames'>,
): VoicePromisePorts {
  return { ...defaultActivityPromisePorts(), reader, log: console };
}
