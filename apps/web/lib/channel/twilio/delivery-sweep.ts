import { type Database, schema } from '@hale/db';
import { and, asc, eq, gt, inArray, lt, or } from 'drizzle-orm';
import { SERVICE_TIMEOUT_MS } from '~/lib/admin/services/outcome';
import { credentials } from '~/lib/admin/services/twilio';
import { applyTwilioStatus, mapTwilioStatus } from './status';

/**
 * The delivery-truth sweep — the reconciler for OUTBOUND rows, the missing half of
 * the receipt loop (the inbound half is reconcile.ts).
 *
 * A ledger row is born 'queued' and a delivery receipt advances it (status.ts). When
 * the receipt is lost — the callback raced the insert, the webhook 500ed, Twilio
 * never fired it — nothing came back for the row, ever: prod showed 4 rows stuck
 * 'queued' since Aug 28 that Twilio itself called delivered, and 30 days of carrier
 * failures (42 of 177 sends) with ZERO failed rows in the DB. Delivery truth never
 * re-entered the system.
 *
 * THE INVARIANT this module enforces: every outbound SMS/WhatsApp row leaves
 * pre-terminal state — by the provider's own answer when one exists, or by a FORCED,
 * named terminal state when nothing can confirm the send (rule #11: absence is an
 * outcome, never silence). Concretely, each tick:
 *
 *   - rows pre-terminal past {@link DELIVERY_POLL_GRACE_MS} are polled at Twilio by
 *     provider id, and the real status is applied through the SAME monotonic guard
 *     the live callback uses ({@link applyTwilioStatus}) — the sweep can never
 *     un-deliver a message or clobber a receipt that lands mid-sweep;
 *   - a 'queued' row past {@link DELIVERY_FORCE_AGE_MS} that Twilio still cannot
 *     call terminal (or cannot be asked about) is forced to `failed` with error code
 *     `delivery_unconfirmed`;
 *   - a row with NO provider id past the poll grace can never be confirmed by
 *     anyone — the send call did not return a sid — and is forced to `failed` /
 *     `send_unconfirmed` immediately;
 *   - a sid Twilio does not know (404) will never resolve, whatever its age:
 *     `failed` / `provider_unknown_message`.
 *
 * The one deliberate rest state: a row at 'sent' whose provider answer stays 'sent'.
 * That is Twilio's own resting status for a carrier that emits no delivery receipts —
 * the handoff HAPPENED, so forcing `failed` would lie in the direction that pages
 * people, and forcing `delivered` would lie in the direction that hides failures.
 * Such rows are polled only until the force age and then left as 'sent', which is why
 * the select below bounds 'sent' rows by age while 'queued' rows stay eligible
 * forever (they are owed a forced terminal, so they cannot accumulate).
 *
 * Forced writes get an audit row (rule #6): unlike a receipt-applied status — which
 * records the provider's own statement, exactly as the status webhook does — a forced
 * terminal is Hale asserting a fact no provider gave it.
 */

/** How long a pre-terminal row may sit before the sweep asks Twilio about it. Receipts
 * normally arrive in seconds; a burst from a long code drains at ~1 segment/second, so
 * minutes of honest 'queued' are real. Past this, the receipt is presumed lost. */
export const DELIVERY_POLL_GRACE_MS = 15 * 60 * 1000;

/** How long a 'queued' row may stay unconfirmable before not-knowing becomes the
 * answer: after a day, no receipt is coming, and `failed`/`delivery_unconfirmed` is
 * the honest terminal (a message nobody can show was handed off). Doubles as the
 * poll ceiling for 'sent' rows (see the module doc's rest-state paragraph). */
export const DELIVERY_FORCE_AGE_MS = 24 * 60 * 60 * 1000;

/** One cron tick's worth of work: each row is one Twilio GET (bounded at
 * SERVICE_TIMEOUT_MS), so the batch is sized to fit the route's wall budget with
 * every request timing out. A deeper backlog drains across ticks. */
export const DELIVERY_SWEEP_BATCH_LIMIT = 50;

/** The channels whose rows are born 'queued' and advanced by a Twilio receipt
 * (ledger.ts `acceptedStatus`) — the only rows a Twilio poll can speak for. */
const RECEIPT_CHANNELS = ['sms', 'whatsapp'] as const;

export interface UnconfirmedOutboundRow {
  id: string;
  familyId: string;
  status: 'queued' | 'sent';
  providerMessageId: string | null;
  createdAt: Date;
}

/**
 * Pre-terminal outbound rows the sweep owes an answer, oldest first. 'queued' rows
 * are eligible at any age past the grace; 'sent' rows only until the force age,
 * after which they rest (see module doc).
 */
export async function selectUnconfirmedOutbound(
  database: Database,
  now: Date,
): Promise<UnconfirmedOutboundRow[]> {
  const staleBefore = new Date(now.getTime() - DELIVERY_POLL_GRACE_MS);
  const restAfter = new Date(now.getTime() - DELIVERY_FORCE_AGE_MS);
  const m = schema.channelMessages;
  const rows = await database
    .select({
      id: m.id,
      familyId: m.familyId,
      status: m.status,
      providerMessageId: m.providerMessageId,
      createdAt: m.createdAt,
    })
    .from(m)
    .where(
      and(
        eq(m.direction, 'out'),
        inArray(m.channel, [...RECEIPT_CHANNELS]),
        lt(m.createdAt, staleBefore),
        or(
          eq(m.status, 'queued'),
          and(eq(m.status, 'sent'), gt(m.createdAt, restAfter)),
        ),
      ),
    )
    .orderBy(asc(m.createdAt))
    .limit(DELIVERY_SWEEP_BATCH_LIMIT);

  // Restates the SQL's status filter for the type system, which cannot read a where
  // clause.
  return rows.filter(
    (row): row is UnconfirmedOutboundRow => row.status === 'queued' || row.status === 'sent',
  );
}

/** What the provider said about one message, or the named reason it could not say. */
export type ProviderMessageState =
  | { ok: true; status: string; errorCode: string | null }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'unreachable'; detail: string };

export interface DeliverySweepDeps {
  database: Database;
  /** One Twilio Messages GET by sid — injected so the sweep is tested with no network. */
  fetchMessageState(providerMessageId: string): Promise<ProviderMessageState>;
  log: Pick<Console, 'warn' | 'error'>;
  now?: () => Date;
}

/** Every row's fate this tick, named (rule #11): the summary is the cron's JSON. */
export interface DeliverySweepSummary {
  scanned: number;
  /** Provider truth applied through the monotonic guard. */
  reconciled: number;
  /** Of those, the provider's answer was a delivery failure. */
  reconciledFailed: number;
  /** Rows the sweep forced to a named terminal state. */
  forced: number;
  /** Provider still pre-terminal (or resting at 'sent') — no new truth this tick. */
  pending: number;
  /** Provider unanswerable this tick; the row is left for the next tick. */
  unreachable: number;
  /** The guarded write matched nothing: a live receipt got there first. */
  advancedElsewhere: number;
  /** A row whose processing threw; logged, and it did not strand the batch. */
  rowErrors: number;
}

/** The named terminal the sweep may assert on its own authority. */
type ForcedCode = 'delivery_unconfirmed' | 'send_unconfirmed' | 'provider_unknown_message';

export async function runDeliverySweep(deps: DeliverySweepDeps): Promise<DeliverySweepSummary> {
  const now = deps.now?.() ?? new Date();
  const rows = await selectUnconfirmedOutbound(deps.database, now);
  const summary: DeliverySweepSummary = {
    scanned: rows.length,
    reconciled: 0,
    reconciledFailed: 0,
    forced: 0,
    pending: 0,
    unreachable: 0,
    advancedElsewhere: 0,
    rowErrors: 0,
  };

  /** The forced write, guarded on the status the sweep OBSERVED: a receipt that
   * landed mid-sweep wins, and the loss is counted, never overwritten. */
  const force = async (row: UnconfirmedOutboundRow, errorCode: ForcedCode): Promise<void> => {
    const updated = await deps.database
      .update(schema.channelMessages)
      .set({ status: 'failed', errorCode })
      .where(and(eq(schema.channelMessages.id, row.id), eq(schema.channelMessages.status, row.status)))
      .returning({ id: schema.channelMessages.id });
    if (updated.length === 0) {
      summary.advancedElsewhere += 1;
      return;
    }
    summary.forced += 1;
    await deps.database.insert(schema.auditLog).values({
      familyId: row.familyId,
      actor: 'system',
      actionTaken: 'delivery_status_forced',
      targetTable: 'channel_messages',
      targetId: row.id,
      after: { status: 'failed', errorCode },
    });
    deps.log.warn(
      { channelMessageId: row.id, errorCode, ageMs: now.getTime() - row.createdAt.getTime() },
      'delivery sweep: nothing could confirm this send — forced to a named terminal state',
    );
  };

  for (const row of rows) {
    const pastForceAge = now.getTime() - row.createdAt.getTime() > DELIVERY_FORCE_AGE_MS;
    try {
      if (!row.providerMessageId) {
        // No sid means the send call never returned one; no receipt or poll can ever
        // resolve this row, so it is forced the moment it is stale.
        await force(row, 'send_unconfirmed');
        continue;
      }

      const state = await deps.fetchMessageState(row.providerMessageId);
      if (!state.ok) {
        if (state.reason === 'not_found') {
          if (row.status === 'queued') {
            await force(row, 'provider_unknown_message');
          } else {
            // A 'sent' row once carried provider evidence; an unknown sid now is
            // strange but not a failure we can assert. It rests, loudly.
            summary.pending += 1;
            deps.log.warn(
              { channelMessageId: row.id },
              "delivery sweep: provider no longer knows a 'sent' row's message — leaving it at sent",
            );
          }
          continue;
        }
        if (row.status === 'queued' && pastForceAge) {
          await force(row, 'delivery_unconfirmed');
        } else {
          summary.unreachable += 1;
          deps.log.warn(
            { channelMessageId: row.id, detail: state.detail },
            'delivery sweep: provider unreachable — row left for the next tick',
          );
        }
        continue;
      }

      const mapped = mapTwilioStatus(state.status);
      const isProgress =
        mapped !== null && mapped !== 'queued' && !(mapped === 'sent' && row.status === 'sent');
      if (isProgress) {
        const applied = await applyTwilioStatus(deps.database, {
          providerMessageId: row.providerMessageId,
          rawStatus: state.status,
          errorCode: state.errorCode,
        });
        if (applied === 'updated') {
          summary.reconciled += 1;
          if (mapped === 'failed') summary.reconciledFailed += 1;
        } else {
          summary.advancedElsewhere += 1;
        }
        continue;
      }

      // The provider itself has nothing terminal to say.
      if (row.status === 'queued' && pastForceAge) {
        await force(row, 'delivery_unconfirmed');
      } else {
        summary.pending += 1;
      }
    } catch (err) {
      summary.rowErrors += 1;
      deps.log.error(
        {
          channelMessageId: row.id,
          err: err instanceof Error ? err.message : String(err),
        },
        'delivery sweep: one row failed — the rest of the batch continues',
      );
    }
  }

  if (summary.reconciled > 0 || summary.forced > 0) {
    deps.log.warn(summary, 'delivery sweep: wrote delivery truth the receipt loop had lost');
  }
  return summary;
}

/**
 * The real poll: one Messages GET, same creds precedence and rule-#11 union as the
 * triage's Monitor read. A 404 is its own named state — for a sid we minted it means
 * the resource is gone or was never this account's, and no retry changes that.
 */
export async function fetchTwilioMessageState(
  fetchImpl: typeof fetch,
  providerMessageId: string,
): Promise<ProviderMessageState> {
  const creds = credentials();
  if (!creds) {
    return { ok: false, reason: 'unreachable', detail: 'twilio credentials not set' };
  }
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  try {
    const res = await fetchImpl(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages/${providerMessageId}.json`,
      {
        headers: {
          Authorization: `Basic ${Buffer.from(`${creds.user}:${creds.pass}`).toString('base64')}`,
        },
        signal: AbortSignal.timeout(SERVICE_TIMEOUT_MS),
      },
    );
    if (res.status === 404) {
      return { ok: false, reason: 'not_found' };
    }
    if (!res.ok) {
      return { ok: false, reason: 'unreachable', detail: `Twilio answered ${res.status}` };
    }
    const body = (await res.json()) as { status?: unknown; error_code?: unknown };
    const status = typeof body.status === 'string' ? body.status : '';
    const errorCode =
      body.error_code === null || body.error_code === undefined ? null : String(body.error_code);
    return { ok: true, status, errorCode };
  } catch (error) {
    return {
      ok: false,
      reason: 'unreachable',
      detail: error instanceof Error ? error.name : 'fetch failed',
    };
  }
}
