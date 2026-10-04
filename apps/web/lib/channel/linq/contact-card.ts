import { type Database, schema } from '@hale/db';
import { and, desc, eq, isNull, or, sql } from 'drizzle-orm';
import { linqFromE164 } from './config';
import {
  patchLinqContactCard,
  retrieveLinqContactCard,
  setupLinqContactCard,
  shareLinqContactCard,
} from './transport';

/**
 * VIL-335 — push Hale's Name and Photo card on a 1:1 iMessage chat, after an
 * outbound has already landed, once per Toronto calendar day per chat.
 *
 * Linq's card is first name plus a public image. There is no organization
 * field, so the name iMessage shows is Hale plus a hibiscus. The photo is the turtle mark
 * the welcome mail already loads from the app origin. Override with
 * LINQ_CONTACT_IMAGE_URL when that asset moves; a local path cannot be the
 * photo because Linq fetches the URL itself.
 *
 * Configuring the card does not show it. Create with POST /v3/contact_card.
 * An existing card is HTTP 409 / code 2014 — PATCH, do not POST over it.
 * GET must say is_active before share. GET or share code 2012 means no card:
 * create it, confirm it is active, then share. Share is
 * POST /v3/chats/{chatId}/share_contact_card with no body, iMessage only,
 * after at least one outbound, once per day per chat after that day's first
 * outbound.
 *
 * A group is not this moment. SMS is not this moment. A failure is logged as
 * code and status and does not fail the turn. Setup that never reached the
 * parent's chat releases the day's claim, so a later fix of the image URL or
 * the partner key can retry. A share that was attempted stays consumed until
 * the next Toronto day, so a retry cannot push the card twice that day.
 *
 * https://docs.linqapp.com/guides/contact-cards/
 * https://docs.linqapp.com/guides/chats/share-contact-card/
 */

/** Hale, a space, then hibiscus U+1F33A. The only name the line card may show. */
export const HALE_CONTACT_FIRST_NAME = 'Hale \u{1F33A}';

/**
 * How long card setup may keep a turn after the reply has already been sent.
 * Setup runs after that send. A slow Linq call past this budget is abandoned
 * for this turn and retried after a later reply.
 */
export const LINQ_CARD_REPLY_BUDGET_MS = 2_000;

/** Resolve when `work` finishes, or when the reply budget passes, whichever is first. */
export function finishCardWithinReplyBudget(work: Promise<unknown>): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      console.warn(
        { budgetMs: LINQ_CARD_REPLY_BUDGET_MS },
        'linq contact card: setup held past the reply budget',
      );
      done();
    }, LINQ_CARD_REPLY_BUDGET_MS);
    void work.then(done, done);
  });
}

/**
 * How many recent share audits one chat reads. A family shares at most once
 * a day per chat, so the newest rows are the ones that decide today. Older
 * rows past this bound cannot hide a share that just landed.
 */
export const CONTACT_CARD_SHARE_LOOKBACK = 32;

/** Once-per-day shares use Hale's home zone, the same zone as quiet hours. */
const CONTACT_CARD_DAY_ZONE = 'America/Toronto';

/** Civil day (YYYY-MM-DD) in America/Toronto. */
export function haleContactCardDay(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: CONTACT_CARD_DAY_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** The turtle tile the digest and welcome mail already point at. */
export const HALE_CONTACT_IMAGE_URL_DEFAULT = 'https://app.villagehale.com/email-logo.png';

export function haleContactImageUrl(): string {
  const override = (process.env.LINQ_CONTACT_IMAGE_URL ?? '').trim();
  return override.length > 0 ? override : HALE_CONTACT_IMAGE_URL_DEFAULT;
}

/**
 * True for a 1:1 iMessage chat with an id. Onboard completion is not the
 * gate: the first outbound is earlier than that. Groups and SMS are not this.
 * `onboardComplete` is accepted and ignored so a caller written when that
 * flag was the gate still typechecks.
 */
export function linqContactCardMoment(input: {
  channel: string;
  chatId: string | null;
  isGroup: boolean;
  onboardComplete?: boolean;
}): boolean {
  return (
    input.channel === 'imessage' &&
    !input.isGroup &&
    typeof input.chatId === 'string' &&
    input.chatId.length > 0
  );
}

export type LinqContactCardOutcome =
  | { status: 'shared' }
  | { status: 'not_sent'; reason: 'not_a_moment' | 'already_shared' | 'no_from' | 'not_configured' }
  | {
      status: 'not_sent';
      reason: 'card_refused' | 'share_refused';
      code: string;
      httpStatus: number;
    }
  | { status: 'not_sent'; reason: 'unreachable' };

export async function shareHaleContactCardOnce(
  database: Database,
  args: {
    familyId: string;
    parentUserId: string;
    chatId: string | null;
    channel: string;
    isGroup: boolean;
    /** Ignored. The first 1:1 outbound is the moment, including before onboard. */
    onboardComplete?: boolean;
    now: Date;
    fetch?: typeof fetch;
  },
): Promise<LinqContactCardOutcome> {
  if (
    !linqContactCardMoment({
      channel: args.channel,
      chatId: args.chatId,
      isGroup: args.isGroup,
    })
  ) {
    return { status: 'not_sent', reason: 'not_a_moment' };
  }
  const chatId = args.chatId;
  if (!chatId) return { status: 'not_sent', reason: 'not_a_moment' };

  // A missing line does not burn the day. There is no card to share.
  if (!linqFromE164()) {
    const missing = await deliverHaleLinqContactCard({
      chatId,
      familyId: args.familyId,
      fetch: args.fetch,
    });
    return missing.outcome;
  }

  const day = haleContactCardDay(args.now);
  const [channel] = await database
    .select({
      id: schema.parentChannels.id,
      familyId: schema.parentChannels.familyId,
      userId: schema.parentChannels.userId,
      revokedAt: schema.parentChannels.revokedAt,
      linqContactCardSharedAt: schema.parentChannels.linqContactCardSharedAt,
    })
    .from(schema.parentChannels)
    .where(
      and(
        eq(schema.parentChannels.familyId, args.familyId),
        eq(schema.parentChannels.userId, args.parentUserId),
        isNull(schema.parentChannels.revokedAt),
      ),
    )
    .limit(1);
  if (!channel) return { status: 'not_sent', reason: 'already_shared' };

  const audits = await database
    .select({
      familyId: schema.auditLog.familyId,
      actionTaken: schema.auditLog.actionTaken,
      after: schema.auditLog.after,
      occurredAt: schema.auditLog.occurredAt,
    })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.familyId, args.familyId),
        eq(schema.auditLog.actionTaken, 'linq_contact_card_shared'),
        or(
          sql`${schema.auditLog.after}->>'chatId' = ${chatId}`,
          sql`${schema.auditLog.after}->>'chatId' is null`,
        ),
      ),
    )
    .orderBy(desc(schema.auditLog.occurredAt))
    .limit(CONTACT_CARD_SHARE_LOOKBACK);
  if (contactCardShareRecordedToday(audits, chatId, day)) {
    return { status: 'not_sent', reason: 'already_shared' };
  }

  const stamp = channel.linqContactCardSharedAt;
  const stampIsToday = stamp instanceof Date && haleContactCardDay(stamp) === day;
  let channelId = channel.id;
  let stampedThisCall = false;
  if (!stampIsToday) {
    const [claimed] = await database
      .update(schema.parentChannels)
      .set({ linqContactCardSharedAt: args.now, updatedAt: args.now })
      .where(
        and(
          eq(schema.parentChannels.id, channel.id),
          stamp instanceof Date
            ? eq(schema.parentChannels.linqContactCardSharedAt, stamp)
            : isNull(schema.parentChannels.linqContactCardSharedAt),
        ),
      )
      .returning({ id: schema.parentChannels.id });
    if (!claimed) return { status: 'not_sent', reason: 'already_shared' };
    channelId = claimed.id;
    stampedThisCall = true;
  }

  const delivered = await deliverHaleLinqContactCard({
    chatId,
    familyId: args.familyId,
    fetch: args.fetch,
  });
  if (!delivered.holdClaim && stampedThisCall) {
    await clearContactCardClaim(database, channelId, stamp instanceof Date ? stamp : null);
  }
  if (delivered.audit) {
    await database.insert(schema.auditLog).values({
      familyId: args.familyId,
      actor: args.parentUserId,
      actionTaken: 'linq_contact_card_shared',
      targetTable: 'parent_channels',
      targetId: channelId,
      occurredAt: args.now,
      after: { ...delivered.audit, chatId, sharedOn: day },
    });
  }
  return delivered.outcome;
}

function isAuditRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A share or a refused share for this chat already landed on this Toronto day.
 * An older audit with no chat id blocks every chat that day. */
function contactCardShareRecordedToday(
  rows: readonly {
    familyId: string;
    actionTaken: string;
    after: unknown;
    occurredAt: Date;
  }[],
  chatId: string,
  day: string,
): boolean {
  return rows.some((row) => {
    if (row.actionTaken !== 'linq_contact_card_shared') return false;
    if (!isAuditRecord(row.after)) return false;
    const outcome = row.after.outcome;
    if (outcome !== 'shared' && outcome !== 'share_refused') return false;
    const recordedDay =
      typeof row.after.sharedOn === 'string'
        ? row.after.sharedOn
        : row.occurredAt instanceof Date
          ? haleContactCardDay(row.occurredAt)
          : null;
    if (recordedDay !== day) return false;
    const recordedChat = typeof row.after.chatId === 'string' ? row.after.chatId : null;
    return recordedChat === null || recordedChat === chatId;
  });
}

export interface HaleContactCardDelivery {
  outcome: Exclude<LinqContactCardOutcome, { reason: 'not_a_moment' | 'already_shared' }>;
  /** False when nothing reached the parent's chat, so a later call may retry. */
  holdClaim: boolean;
  /** Written to audit_log once a family exists. Null when there is nothing to record. */
  audit: Record<string, unknown> | null;
}

/**
 * Setup, confirm the line card is active, and share. No channel-row claim:
 * before a family exists the intake session holds that, and
 * {@link shareHaleContactCardOnce} holds it on parent_channels afterwards.
 */
export async function deliverHaleLinqContactCard(args: {
  chatId: string;
  familyId: string | null;
  fetch?: typeof fetch;
}): Promise<HaleContactCardDelivery> {
  const from = linqFromE164();
  if (!from) {
    console.warn(
      { familyId: args.familyId },
      'linq contact card: LINQ_FROM_E164 is unset — the card was not shared',
    );
    return {
      outcome: { status: 'not_sent', reason: 'no_from' },
      holdClaim: false,
      audit: null,
    };
  }

  const imageUrl = haleContactImageUrl();
  const ready = await ensureActiveHaleCard({
    phoneNumber: from,
    imageUrl,
    familyId: args.familyId,
    fetch: args.fetch,
  });
  if (!ready.ok) return ready.delivery;

  try {
    await shareLinqContactCard({ chatId: args.chatId, fetch: args.fetch });
  } catch (err) {
    // 2012: no card on the from number. Create it, confirm it, share once.
    if (linqFailureCode(err) !== '2012') return shareRefused(args.familyId, err);
    const created = await ensureActiveHaleCard({
      phoneNumber: from,
      imageUrl,
      familyId: args.familyId,
      fetch: args.fetch,
    });
    if (!created.ok) return created.delivery;
    try {
      await shareLinqContactCard({ chatId: args.chatId, fetch: args.fetch });
    } catch (again) {
      return shareRefused(args.familyId, again);
    }
  }

  console.info({ familyId: args.familyId, outcome: 'shared' }, 'linq contact card: shared');
  return {
    holdClaim: true,
    audit: { outcome: 'shared', firstName: HALE_CONTACT_FIRST_NAME },
    outcome: { status: 'shared' },
  };
}

const CONTACT_CARD_MISSING = '2012';

async function applyHaleContactCard(args: {
  phoneNumber: string;
  imageUrl: string;
  fetch?: typeof fetch;
}): Promise<Awaited<ReturnType<typeof setupLinqContactCard>>> {
  let setup = await setupLinqContactCard({
    phoneNumber: args.phoneNumber,
    firstName: HALE_CONTACT_FIRST_NAME,
    imageUrl: args.imageUrl,
    fetch: args.fetch,
  });
  // The first hello's setup is the call that times out at SEND_TIMEOUT_MS.
  // One more try in this same turn, before the session records the miss.
  if (setup.status === 'unreachable') {
    setup = await setupLinqContactCard({
      phoneNumber: args.phoneNumber,
      firstName: HALE_CONTACT_FIRST_NAME,
      imageUrl: args.imageUrl,
      fetch: args.fetch,
    });
  }
  return setup;
}

function setupBlocksShare(setup: Awaited<ReturnType<typeof setupLinqContactCard>>): boolean {
  if (setup.status === 'accepted') return false;
  // POST can store the card inactive. GET is what decides, not that body.
  return !(setup.status === 'refused' && setup.code === 'card_inactive');
}

function setupNotApplied(
  familyId: string | null,
  setup: Awaited<ReturnType<typeof setupLinqContactCard>>,
): HaleContactCardDelivery {
  const code = setup.status === 'refused' ? setup.code : setup.status;
  const httpStatus = setup.status === 'refused' ? setup.httpStatus : 0;
  console.warn({ familyId, code, httpStatus }, 'linq contact card: the Hale card was not applied');
  if (setup.status === 'not_configured') {
    return {
      outcome: { status: 'not_sent', reason: 'not_configured' },
      holdClaim: false,
      audit: null,
    };
  }
  return {
    holdClaim: false,
    audit: { outcome: 'card_refused', code },
    outcome:
      setup.status === 'unreachable'
        ? { status: 'not_sent', reason: 'unreachable' }
        : { status: 'not_sent', reason: 'card_refused', code, httpStatus },
  };
}

/**
 * POST the card (PATCH on 409/2014), then GET. Share only when that GET says
 * the line card is active and its first name is the code name. A 2012 on GET
 * creates the card and confirms once more.
 */
async function ensureActiveHaleCard(args: {
  phoneNumber: string;
  imageUrl: string;
  familyId: string | null;
  fetch?: typeof fetch;
}): Promise<{ ok: true } | { ok: false; delivery: HaleContactCardDelivery }> {
  const setup = await applyHaleContactCard(args);
  if (setupBlocksShare(setup))
    return { ok: false, delivery: setupNotApplied(args.familyId, setup) };

  let live = await retrieveLinqContactCard({ phoneNumber: args.phoneNumber, fetch: args.fetch });
  if (live.status === 'refused' && live.code === CONTACT_CARD_MISSING) {
    const created = await applyHaleContactCard(args);
    if (setupBlocksShare(created)) {
      return { ok: false, delivery: setupNotApplied(args.familyId, created) };
    }
    live = await retrieveLinqContactCard({ phoneNumber: args.phoneNumber, fetch: args.fetch });
  }

  if (live.status === 'active' && live.firstName && live.firstName !== HALE_CONTACT_FIRST_NAME) {
    console.warn(
      { familyId: args.familyId, outcome: 'name_mismatch' },
      'linq contact card: stored first name is not the code name — patching',
    );
    const patched = await patchLinqContactCard({
      phoneNumber: args.phoneNumber,
      firstName: HALE_CONTACT_FIRST_NAME,
      imageUrl: args.imageUrl,
      fetch: args.fetch,
    });
    const again = await retrieveLinqContactCard({
      phoneNumber: args.phoneNumber,
      fetch: args.fetch,
    });
    const aligned =
      patched.status === 'accepted' &&
      again.status === 'active' &&
      (again.firstName === null || again.firstName === HALE_CONTACT_FIRST_NAME);
    if (!aligned) {
      console.error(
        { familyId: args.familyId, outcome: 'name_mismatch', patch: patched.status },
        'linq contact card: stored name still differs — nothing was shared',
      );
      return {
        ok: false,
        delivery: {
          holdClaim: false,
          audit: { outcome: 'card_refused', code: 'name_mismatch' },
          outcome: {
            status: 'not_sent',
            reason: 'card_refused',
            code: 'name_mismatch',
            httpStatus: patched.status === 'refused' ? patched.httpStatus : 0,
          },
        },
      };
    }
    live = again;
  }

  if (live.status !== 'active') {
    console.warn(
      { familyId: args.familyId, retrieve: live.status },
      'linq contact card: the card is not active on the line — nothing was shared',
    );
    return {
      ok: false,
      delivery: {
        holdClaim: false,
        audit: { outcome: 'card_inactive', retrieve: live.status },
        outcome:
          live.status === 'not_configured'
            ? { status: 'not_sent', reason: 'not_configured' }
            : live.status === 'unreachable'
              ? { status: 'not_sent', reason: 'unreachable' }
              : {
                  status: 'not_sent',
                  reason: 'card_refused',
                  code: live.status === 'refused' ? live.code : 'card_inactive',
                  httpStatus: live.status === 'refused' ? live.httpStatus : 0,
                },
      },
    };
  }
  if (live.firstName && live.firstName !== HALE_CONTACT_FIRST_NAME) {
    return {
      ok: false,
      delivery: {
        holdClaim: false,
        audit: { outcome: 'card_refused', code: 'name_mismatch' },
        outcome: {
          status: 'not_sent',
          reason: 'card_refused',
          code: 'name_mismatch',
          httpStatus: 0,
        },
      },
    };
  }
  return { ok: true };
}

function linqFailureCode(err: unknown): string {
  return err instanceof Error && 'code' in err ? String(err.code) : 'unknown';
}

function shareRefused(familyId: string | null, err: unknown): HaleContactCardDelivery {
  const code = linqFailureCode(err);
  const httpStatus =
    err instanceof Error && 'httpStatus' in err && typeof err.httpStatus === 'number'
      ? err.httpStatus
      : 0;
  console.warn({ familyId, code, httpStatus }, 'linq contact card: share did not land');
  return {
    holdClaim: true,
    audit: { outcome: 'share_refused', code },
    outcome: { status: 'not_sent', reason: 'share_refused', code, httpStatus },
  };
}

/** Setup never reached the parent's chat. Put the last shared time back so
 * this miss can be retried, and a share from an earlier day is still the
 * stored timestamp. A share that was attempted stays consumed until the next
 * Toronto day, so a retry cannot push the card twice that day. */
async function clearContactCardClaim(
  database: Database,
  channelId: string,
  restore: Date | null,
): Promise<void> {
  await database
    .update(schema.parentChannels)
    .set({ linqContactCardSharedAt: restore })
    .where(eq(schema.parentChannels.id, channelId));
}
