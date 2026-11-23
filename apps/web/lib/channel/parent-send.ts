import { type Database, schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { isGarbledRefusal } from '~/lib/channel/garbled-refusal';
import { SENT_STATUSES, acceptedStatus } from '~/lib/channel/ledger';
import { parentSendReceiptEnabled } from '~/lib/channel/linq/config';
import { LinqSendError } from '~/lib/channel/linq/transport';
import { linqRefusedForCertain } from '~/lib/channel/outbound-transport';
import { PreviewCaptureRefused } from '~/lib/channel/preview-capture-transport';
import { COMPOSE_HOLD_FIRST_GAP_MS } from '~/lib/loop/reminders/schedule';
import type { OpsPager } from '~/lib/monitoring/failure-page';

/**
 * VIL-749 and VIL-753. One send for a parent-facing text.
 *
 * An earlier attempt (8e791f3c3, reverted in 05bb18d88) wrote an "unconfirmed" row
 * and stopped. Readers still treated that row as the question having been seen, as
 * the notice having been delivered, or wrote the marker outside the audit transaction.
 * This path does not do that:
 *
 * - The row starts `failed` / `send_in_flight`. That is not a sent status, so a crash
 *   between the claim and Linq leaves nothing that reads as delivered.
 * - It becomes sent only after Linq returns a message id, in the same transaction as
 *   the audit row.
 * - A certain refusal stays `failed` with Linq's code, is not a send, and pages #ops.
 *   It cannot have landed, so the next call uses a new Linq key. Linq remembering the
 *   refused one must not block the text the parent is still owed.
 * - A timeout, a 5xx, a 408, a 409 or a 425 stays `failed` under `unconfirmed:`. It is
 *   not a send. The next call uses the same Linq key, which is the family id and the
 *   logical key, hashed before it leaves. Linq then cannot put a second bubble down.
 * - `not_configured` and a garbled draft release the key. Nothing was handed to Linq,
 *   and a later call must be able to try. Neither pages as an unsent text.
 *
 * With {@link parentSendReceiptEnabled} off, callers do not enter here.
 */

export const PARENT_SEND_IN_FLIGHT = 'send_in_flight';
const UNCONFIRMED_PREFIX = 'unconfirmed:';

export type ParentSendSurface = 'one_to_one' | 'group_line';

/** The Linq idempotency identity for one logical message. Hashed before it leaves. */
export function parentLinqKey(familyId: string, logicalKey: string): string {
  return `${familyId}:${logicalKey}`;
}

/** A row the parent was actually sent. A refusal or an unconfirmed try is not one. */
export function parentSendClosed(row: {
  status: string;
  errorCode: string | null;
  providerMessageId: string | null;
}): boolean {
  if (row.providerMessageId !== null) return true;
  return (SENT_STATUSES as readonly string[]).includes(row.status);
}

type ChannelCategory = (typeof schema.channelMessages.$inferInsert)['category'];

export type ParentSendResult =
  | {
      outcome: 'sent';
      rowId: string;
      providerMessageId: string;
      chatId: string | null;
    }
  | { outcome: 'already_sent'; rowId: string }
  | { outcome: 'in_flight' }
  | { outcome: 'refused'; code: string; rowId: string }
  | { outcome: 'unknown'; code: string; rowId: string }
  | { outcome: 'released'; code: string };

interface ParentSendInput {
  familyId: string;
  parentUserId: string;
  /** Stable identity of this text. Retries pass the same string. */
  logicalKey: string;
  channel: 'imessage' | 'sms';
  category: ChannelCategory;
  templateKey: string;
  providerChatId: string | null;
  now: Date;
  /** Stored on the row only after Linq accepts. Null keeps the body empty. */
  recordBody: string | null;
  surface: ParentSendSurface;
  /**
   * This caller will not try again. An answer that does not prove a refusal pages
   * #ops. A caller that will retry leaves this false, and the next call reuses the key.
   */
  final: boolean;
  pager: OpsPager;
  send: (sendKey: string) => Promise<{ providerMessageId: string; chatId?: string | null }>;
}

const ROW = {
  id: schema.channelMessages.id,
  status: schema.channelMessages.status,
  errorCode: schema.channelMessages.errorCode,
  providerMessageId: schema.channelMessages.providerMessageId,
  createdAt: schema.channelMessages.createdAt,
};

type SendRow = {
  id: string;
  status: string;
  errorCode: string | null;
  providerMessageId: string | null;
  createdAt: Date;
};

const RETRY_MARK = ':retry:';

function splitStored(errorCode: string | null): { code: string | null; retry: number } {
  if (!errorCode) return { code: null, retry: 0 };
  const at = errorCode.lastIndexOf(RETRY_MARK);
  if (at === -1) return { code: errorCode, retry: 0 };
  const retry = Number(errorCode.slice(at + RETRY_MARK.length));
  if (!Number.isInteger(retry) || retry < 1) return { code: errorCode, retry: 0 };
  return { code: errorCode.slice(0, at), retry };
}

function withRetry(code: string, retry: number): string {
  return retry === 0 ? code : `${code}${RETRY_MARK}${retry}`;
}

/** The key this try hands Linq. An unclear try reuses it. A certain refusal gets the next. */
function linqKeyFor(familyId: string, logicalKey: string, retry: number): string {
  const base = parentLinqKey(familyId, logicalKey);
  return retry === 0 ? base : `${base}${RETRY_MARK}${retry}`;
}

function nextRetry(row: SendRow | null): number {
  if (!row) return 0;
  const { code, retry } = splitStored(row.errorCode);
  if (code === PARENT_SEND_IN_FLIGHT || code?.startsWith(UNCONFIRMED_PREFIX) === true) return retry;
  return retry + 1;
}

function freshInFlight(row: SendRow, now: Date): boolean {
  return (
    splitStored(row.errorCode).code === PARENT_SEND_IN_FLIGHT &&
    now.getTime() - row.createdAt.getTime() <= COMPOSE_HOLD_FIRST_GAP_MS
  );
}

async function readRow(
  database: Database,
  input: { familyId: string; logicalKey: string },
): Promise<SendRow | null> {
  const [row] = await database
    .select(ROW)
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.familyId, input.familyId),
        eq(schema.channelMessages.dedupeKey, input.logicalKey),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function pageUnsent(
  pager: OpsPager,
  surface: ParentSendSurface,
  reason: 'send_refused' | 'not_confirmed',
): Promise<void> {
  await pager.page({
    site: 'parent_send_unsent',
    facts: { surface, reason },
    count: 1,
  });
}

/** One caller owns this row until it settles. `claimAt` is the fence the next writer must match. */
export interface OwnedParentSend {
  claimId: string;
  claimAt: Date;
  retry: number;
  sendKey: string;
  inFlightCode: string;
}

export type BegunParentSend =
  | { state: 'owned'; owned: OwnedParentSend }
  | { state: 'already_sent'; rowId: string }
  | { state: 'in_flight' };

/**
 * Claim the row before any work that must not run twice, such as minting a sign-in
 * link. A fresh in-flight row, or a claim another caller just took, returns without
 * a send. The timestamp on the row changes on every claim, so two callers that read
 * the same stale row cannot both take it.
 */
export async function beginParentSend(
  database: Database,
  input: Omit<ParentSendInput, 'send' | 'pager' | 'final'>,
): Promise<BegunParentSend> {
  const existing = await readRow(database, input);
  if (existing && parentSendClosed(existing)) {
    return { state: 'already_sent', rowId: existing.id };
  }
  if (existing && freshInFlight(existing, input.now)) {
    return { state: 'in_flight' };
  }

  const retry = nextRetry(existing);
  const inFlightCode = withRetry(PARENT_SEND_IN_FLIGHT, retry);
  const claimed = existing
    ? await takeOver(database, existing, input.now, inFlightCode)
    : await insertClaim(database, input, inFlightCode);
  if (!claimed) {
    const raced = await readRow(database, input);
    if (raced && parentSendClosed(raced)) return { state: 'already_sent', rowId: raced.id };
    return { state: 'in_flight' };
  }
  return {
    state: 'owned',
    owned: {
      claimId: claimed.id,
      claimAt: claimed.createdAt,
      retry,
      sendKey: linqKeyFor(input.familyId, input.logicalKey, retry),
      inFlightCode,
    },
  };
}

/**
 * Send one logical text, or continue the row a previous try left. An unclear try
 * reuses {@link parentLinqKey} of this family and `logicalKey`. A certain refusal
 * uses the next key, because that try cannot have landed.
 */
export async function deliverParentText(
  database: Database,
  input: ParentSendInput,
): Promise<ParentSendResult> {
  const begun = await beginParentSend(database, input);
  if (begun.state === 'already_sent') return { outcome: 'already_sent', rowId: begun.rowId };
  if (begun.state === 'in_flight') return { outcome: 'in_flight' };
  return completeParentSend(database, begun.owned, input);
}

/** Drop a claim that never reached Linq, so a later try can start clean. */
export async function releaseParentSend(database: Database, owned: OwnedParentSend): Promise<void> {
  await database
    .update(schema.channelMessages)
    .set({ status: 'failed', errorCode: 'released', dedupeKey: null, body: null })
    .where(owns(owned));
}

function owns(owned: OwnedParentSend) {
  return and(
    eq(schema.channelMessages.id, owned.claimId),
    eq(schema.channelMessages.errorCode, owned.inFlightCode),
    eq(schema.channelMessages.createdAt, owned.claimAt),
  );
}

async function insertClaim(
  database: Database,
  input: Omit<ParentSendInput, 'send' | 'pager' | 'final'>,
  inFlightCode: string,
): Promise<{ id: string; createdAt: Date } | null> {
  const [claimed] = await database
    .insert(schema.channelMessages)
    .values({
      familyId: input.familyId,
      parentUserId: input.parentUserId,
      channel: input.channel,
      direction: 'out',
      category: input.category,
      templateKey: input.templateKey,
      dedupeKey: input.logicalKey,
      providerChatId: input.providerChatId,
      status: 'failed',
      errorCode: inFlightCode,
      body: null,
    })
    .onConflictDoNothing()
    .returning({
      id: schema.channelMessages.id,
      createdAt: schema.channelMessages.createdAt,
    });
  return claimed ?? null;
}

/** A crashed or unconfirmed try. Null: another caller took the row first. */
async function takeOver(
  database: Database,
  row: SendRow,
  now: Date,
  inFlightCode: string,
): Promise<{ id: string; createdAt: Date } | null> {
  const [taken] = await database
    .update(schema.channelMessages)
    .set({ errorCode: inFlightCode, createdAt: now })
    .where(
      and(
        eq(schema.channelMessages.id, row.id),
        eq(schema.channelMessages.errorCode, row.errorCode ?? ''),
        eq(schema.channelMessages.createdAt, row.createdAt),
      ),
    )
    .returning({
      id: schema.channelMessages.id,
      createdAt: schema.channelMessages.createdAt,
    });
  return taken ?? null;
}

export async function completeParentSend(
  database: Database,
  owned: OwnedParentSend,
  input: ParentSendInput,
): Promise<ParentSendResult> {
  try {
    const sent = await input.send(owned.sendKey);
    const wrote = await database.transaction(async (tx) => {
      const [row] = await tx
        .update(schema.channelMessages)
        .set({
          status: acceptedStatus(input.channel),
          errorCode: null,
          providerMessageId: sent.providerMessageId,
          providerChatId: sent.chatId ?? input.providerChatId,
          sentAt: input.now,
          body: input.recordBody,
        })
        .where(owns(owned))
        .returning({ id: schema.channelMessages.id });
      if (!row) return false;
      await tx.insert(schema.auditLog).values({
        familyId: input.familyId,
        actor: input.parentUserId,
        actionTaken: 'sms_reply_sent',
        targetTable: 'channel_messages',
        targetId: owned.claimId,
        after: { templateKey: input.templateKey, surface: input.surface },
      });
      return true;
    });
    if (!wrote) return { outcome: 'in_flight' };
    return {
      outcome: 'sent',
      rowId: owned.claimId,
      providerMessageId: sent.providerMessageId,
      chatId: sent.chatId ?? input.providerChatId,
    };
  } catch (err) {
    return settleFailure(database, input, owned, err);
  }
}

type FailureKind = 'garbled' | 'release' | 'refused' | 'unknown';

function failureKind(err: unknown): FailureKind {
  if (isGarbledRefusal(err)) return 'garbled';
  if (err instanceof PreviewCaptureRefused) return 'release';
  if (
    err instanceof LinqSendError &&
    (err.code === 'not_configured' || err.code === 'preview_capture')
  ) {
    return 'release';
  }
  if (linqRefusedForCertain(err)) return 'refused';
  return 'unknown';
}

function failureCode(err: unknown): string {
  if (err instanceof LinqSendError) return err.code;
  if (err instanceof PreviewCaptureRefused) return err.reason;
  return 'unknown';
}

async function settleFailure(
  database: Database,
  input: ParentSendInput,
  owned: OwnedParentSend,
  err: unknown,
): Promise<ParentSendResult> {
  const kind = failureKind(err);
  const code = failureCode(err);
  if (kind === 'garbled' || kind === 'release') {
    const [released] = await database
      .update(schema.channelMessages)
      .set({ status: 'failed', errorCode: code, dedupeKey: null, body: null })
      .where(owns(owned))
      .returning({ id: schema.channelMessages.id });
    if (!released) return { outcome: 'in_flight' };
    console.warn(
      { familyId: input.familyId, surface: input.surface, code },
      'parent send: nothing sent',
    );
    return { outcome: 'released', code };
  }

  const unconfirmed = kind === 'unknown';
  const stored = withRetry(unconfirmed ? `${UNCONFIRMED_PREFIX}${code}` : code, owned.retry);
  const page = kind === 'refused' || (unconfirmed && input.final);
  const wrote = await database.transaction(async (tx) => {
    const [row] = await tx
      .update(schema.channelMessages)
      .set({ status: 'failed', errorCode: stored, body: null })
      .where(owns(owned))
      .returning({ id: schema.channelMessages.id });
    if (!row) return false;
    if (!page) return true;
    await tx.insert(schema.auditLog).values({
      familyId: input.familyId,
      actor: 'system',
      actionTaken: 'parent_send_unsent',
      targetTable: 'channel_messages',
      targetId: owned.claimId,
      after: {
        surface: input.surface,
        failure: kind === 'refused' ? 'send_refused' : 'not_confirmed',
      },
    });
    return true;
  });
  if (!wrote) return { outcome: 'in_flight' };
  if (page) {
    await pageUnsent(
      input.pager,
      input.surface,
      kind === 'refused' ? 'send_refused' : 'not_confirmed',
    );
  }
  console.error(
    { familyId: input.familyId, surface: input.surface, code: stored },
    'parent send: Linq did not accept, not marked sent',
  );
  if (kind === 'refused') return { outcome: 'refused', code, rowId: owned.claimId };
  return { outcome: 'unknown', code, rowId: owned.claimId };
}

export { parentSendReceiptEnabled };
