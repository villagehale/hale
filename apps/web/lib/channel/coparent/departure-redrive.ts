import { type Database, schema } from '@hale/db';
import { and, asc, eq, gte, inArray, isNotNull } from 'drizzle-orm';
import {
  MAX_REDRIVE_PER_RUN,
  REDRIVE_MAX_AGE_MS,
  isRedriveSlot,
  redriveParentTimeZone,
} from '~/lib/channel/redrive-slot';
import {
  type DepartureNoticePorts,
  departureNoticeDedupeKey,
  stayingParent,
  tellStayingParent,
} from './departure-notice';

/**
 * The departure notice quiet hours refused, finished the next morning.
 *
 * `URGENCY_ALLOWED.co_parent_departed` is false and stays false: a departure is not
 * worth less at 08:00 — the seat is already gone and the week is already theirs — and
 * waking a house at 23:00 to say a co-parent left is the cruellest hour the message
 * could pick. But a floor that defers with nothing behind it is not a deferral, it is a
 * drop with a receipt, and `tellStayingParent` had exactly one caller: a single
 * synchronous call from the erasure route. A household that ended after dark was never
 * told. This is the other half of that floor.
 *
 * IT READS THE DEPARTURE, NOT THE REFUSAL, and that is the whole design choice here.
 * The obligation is "a departure ends with the staying parent told", so the open set is
 * the set of departures with no notice claimed — which covers the quiet-hours hold the
 * receipt records AND the case no receipt can record, where the route committed the
 * transaction and then died before it ever called the notice. Selecting from the
 * suppression row would have re-driven only the failures Hale managed to write down.
 *
 * IT IS THE SAME MECHANISM AS THE CONTACT CARD'S, not a second one: the same hourly
 * cron leg, the same local hour, the same staleness bound and the same per-run cap, all
 * from one place (redrive-slot.ts). What is its own is only what is genuinely its own —
 * which obligation is open, and which function discharges it.
 *
 * IT COMPOSES NOTHING AND REACHES NO TRANSPORT. Every send is `tellStayingParent`, with
 * its dedupe claim, its gate call, its thread write and its audit row, so a re-driven
 * notice is indistinguishable from one sent on the night it was owed.
 */

/** A departure still owed its notice. `departedUserId` is the audit row's target — the
 * half of the dedupe key that no channel_messages row carries. */
interface OpenDeparture {
  familyId: string;
  departedUserId: string;
}

/**
 * Every way a tick can end, counted (rule #11). `open` is the population the sweep
 * looked at and `due` the slice whose local clock said now — without both, the zero
 * that most ticks return is unreadable.
 *
 * The refusals are split rather than summed because they mean opposite things about
 * tomorrow: `heldAgain` is a household whose slot arithmetic went wrong and who is still
 * owed, while `refused` is a parent the gate will keep refusing on grounds this sweep
 * has no business overruling (no channel, no watch consent).
 */
export interface DepartureNoticeRedriveResult {
  open: number;
  due: number;
  deferred: number;
  sent: number;
  alreadySent: number;
  heldAgain: number;
  refused: number;
  dark: number;
  noStayingParent: number;
  noSendTarget: number;
  sendFailed: number;
}

export function emptyDepartureRedriveResult(): DepartureNoticeRedriveResult {
  return {
    open: 0,
    due: 0,
    deferred: 0,
    sent: 0,
    alreadySent: 0,
    heldAgain: 0,
    refused: 0,
    dark: 0,
    noStayingParent: 0,
    noSendTarget: 0,
    sendFailed: 0,
  };
}

/**
 * The departures inside the staleness window whose notice key nobody has claimed.
 *
 * The audit row is the durable fact — `departCoParent` writes it in the same transaction
 * that removes the seat, so it exists iff the departure happened, and it carries the
 * departed user id that the notice's dedupe key needs and no ledger row holds.
 *
 * OLDEST FIRST, which is the per-run cap's fairness: with no ORDER BY, a capped run
 * serves whichever hundred the heap handed back, which can be the same wrong hundred
 * every morning until the staleness bound ages the rest out unserved.
 */
export async function selectOpenDepartures(
  database: Database,
  now: Date,
): Promise<OpenDeparture[]> {
  const departures = await database
    .select({
      familyId: schema.auditLog.familyId,
      departedUserId: schema.auditLog.targetId,
    })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.actionTaken, 'co_parent_departed'),
        eq(schema.auditLog.targetTable, 'family_members'),
        isNotNull(schema.auditLog.targetId),
        gte(schema.auditLog.occurredAt, new Date(now.getTime() - REDRIVE_MAX_AGE_MS)),
      ),
    )
    .orderBy(asc(schema.auditLog.occurredAt));

  const open = departures.flatMap((row) =>
    row.departedUserId === null
      ? []
      : [{ familyId: row.familyId, departedUserId: row.departedUserId }],
  );
  if (open.length === 0) return [];

  const keys = open.map((d) => departureNoticeDedupeKey(d.familyId, d.departedUserId));
  const claimed = new Set(
    (
      await database
        .select({ dedupeKey: schema.channelMessages.dedupeKey })
        .from(schema.channelMessages)
        .where(inArray(schema.channelMessages.dedupeKey, keys))
    ).map((row) => row.dedupeKey),
  );
  return open.filter((d) => !claimed.has(departureNoticeDedupeKey(d.familyId, d.departedUserId)));
}

export async function runDepartureNoticeRedrive(
  database: Database,
  deps: { ports: DepartureNoticePorts },
  now: Date = new Date(),
): Promise<DepartureNoticeRedriveResult> {
  const result = emptyDepartureRedriveResult();

  const open = await selectOpenDepartures(database, now);
  result.open = open.length;

  const due: OpenDeparture[] = [];
  for (const departure of open) {
    const parentUserId = await stayingParent(database, departure.familyId);
    if (parentUserId === null) {
      // The household's primary seat is gone too — nothing to tell, and not the same
      // fact as a refusal. `tellStayingParent` would say so itself; counting it here
      // keeps the sweep from asking the gate about a parent who does not exist.
      result.noStayingParent += 1;
      continue;
    }
    if (!isRedriveSlot(now, await redriveParentTimeZone(database, parentUserId))) continue;
    due.push(departure);
  }
  result.due = due.length;
  result.deferred = Math.max(0, due.length - MAX_REDRIVE_PER_RUN);
  if (result.deferred > 0) {
    console.warn(
      { deferred: result.deferred, cap: MAX_REDRIVE_PER_RUN },
      'departure notice re-drive: more open departures than one run sends - the rest keep their place',
    );
  }

  for (const departure of due.slice(0, MAX_REDRIVE_PER_RUN)) {
    const outcome = await tellStayingParent(database, { ...departure, now }, deps.ports);
    if (outcome === 'sent') result.sent += 1;
    else if (outcome === 'already_sent') result.alreadySent += 1;
    else if (outcome === 'dark') result.dark += 1;
    else if (outcome === 'no_staying_parent') result.noStayingParent += 1;
    else if (outcome === 'no_send_target') result.noSendTarget += 1;
    else if (outcome === 'send_failed') result.sendFailed += 1;
    else if (outcome === 'gate_refused:quiet_hours') result.heldAgain += 1;
    else result.refused += 1;
  }

  return result;
}
