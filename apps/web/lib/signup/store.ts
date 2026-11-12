import { type Database, schema } from '@hale/db';
import { deriveStage } from '@hale/types';
import { and, desc, eq, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import { pageOps } from '~/lib/monitoring/failure-page';
import { redactSignupAudit } from './audit';
import { signupProviderHost } from './consent';
import { normalizeSession } from './forms/details';
import type { BusyInterval, SignupIdentity, SignupOffer, SignupSession } from './types';
import { registrationUrlAllowed } from './url';

const KEY = /^[a-z0-9][a-z0-9._:-]{0,79}$/i;

/** A pending ask the parent's words replaced. The program's public facts, never a person. */
export interface ReplacedSignupOffer {
  offerId: string;
  activityLabel: string | null;
  providerHost: string;
  sessionLabels: string[];
}

export type RecordOfferResult =
  | { ok: true; id: string; replaced: ReplacedSignupOffer[] }
  | { ok: false; reason: string };

/** The parent already has an open ask on this site and this one does not replace it. */
class OfferExists extends Error {}

export async function recordSignupOffer(
  database: Database,
  input: {
    familyId: string;
    childId: string;
    parentUserId: string;
    activityKey: string;
    /** The program's public name as the page or the parent gave it. */
    activityLabel?: string | null;
    registrationUrl: string;
    sessions: SignupSession[];
    approvedPriceCents: number | null;
    /** VIL-558 · when registration opens, for an offer Hale can carry out as a plan. */
    planOpensAt?: Date | null;
    /** Program is already open: Hale registers now, not at a future open. */
    planAlreadyOpen?: boolean;
    /**
     * Pending asks a model reading of the parent's own words this turn says this ask
     * replaces. Only this parent's own pending asks in this family are ever closed.
     */
    supersede?: readonly string[];
    now: Date;
  },
): Promise<RecordOfferResult> {
  if (!KEY.test(input.activityKey)) return { ok: false, reason: 'activity_key' };
  const allowed = registrationUrlAllowed(input.registrationUrl);
  if (!allowed.ok) return { ok: false, reason: 'url_refused' };
  const providerHost = signupProviderHost(new URL(allowed.href).hostname);
  if (input.sessions.length === 0 || input.sessions.length > 12) {
    return { ok: false, reason: 'sessions' };
  }
  const sessions = input.sessions.map((session) => normalizeSession(session));
  if (
    sessions.some(
      (session) => session === null || !KEY.test(session.id) || session.label.trim().length === 0,
    )
  ) {
    return { ok: false, reason: 'sessions' };
  }
  const [child] = await database
    .select({ id: schema.children.id })
    .from(schema.children)
    .where(and(eq(schema.children.id, input.childId), eq(schema.children.familyId, input.familyId)))
    .limit(1);
  if (!child) return { ok: false, reason: 'child_missing' };
  const offers = schema.authorizedSignupOffers;
  const supersede = [...new Set(input.supersede ?? [])];
  try {
    return await database.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Database;
      // Several asks may be open at once, one per site. An earlier ask closes only when
      // the parent's own words replaced it, and only when it is theirs and still an ask: a
      // co-parent's ask is theirs to answer, and a planned or running offer is a commitment.
      const replaced =
        supersede.length === 0
          ? []
          : await tx
              .update(offers)
              .set({ status: 'handed_back', updatedAt: input.now })
              .where(
                and(
                  eq(offers.familyId, input.familyId),
                  eq(offers.parentUserId, input.parentUserId),
                  eq(offers.status, 'pending'),
                  inArray(offers.id, supersede),
                ),
              )
              .returning({
                id: offers.id,
                activityLabel: offers.activityLabel,
                providerHost: offers.providerHost,
                sessions: offers.sessions,
              });
      const [open] = await tx
        .select({ id: offers.id })
        .from(offers)
        .where(
          and(
            eq(offers.familyId, input.familyId),
            eq(offers.providerHost, providerHost),
            eq(offers.status, 'pending'),
          ),
        )
        .limit(1);
      // Thrown, not returned, so the closes above roll back with it.
      if (open) throw new OfferExists();
      const [row] = await tx
        .insert(offers)
        .values({
          familyId: input.familyId,
          childId: input.childId,
          parentUserId: input.parentUserId,
          activityKey: input.activityKey,
          activityLabel: input.activityLabel ?? null,
          registrationUrl: allowed.href,
          providerHost,
          sessions: sessions.filter((session): session is SignupSession => session !== null),
          approvedPriceCents: input.approvedPriceCents,
          planOpensAt: input.planOpensAt ?? null,
          planAlreadyOpen: input.planAlreadyOpen === true,
          status: 'pending',
          createdAt: input.now,
          updatedAt: input.now,
        })
        .returning({ id: offers.id });
      if (!row) throw new Error('signup offer insert returned no row');
      for (const prior of replaced) {
        await tx.insert(schema.auditLog).values({
          familyId: input.familyId,
          actor: input.parentUserId,
          actionTaken: 'authorized_signup_step',
          targetTable: 'authorized_signup_offers',
          targetId: prior.id,
          after: redactSignupAudit({
            step: 'offer_superseded',
            host: prior.providerHost,
            supersededBy: row.id,
          }),
        });
      }
      return {
        ok: true as const,
        id: row.id,
        replaced: replaced.map((prior) => ({
          offerId: prior.id,
          activityLabel: prior.activityLabel,
          providerHost: prior.providerHost,
          sessionLabels: prior.sessions.map((session) => session.label),
        })),
      };
    });
  } catch (err) {
    if (err instanceof OfferExists || isUniqueViolation(err, ONE_PENDING_PER_HOST_INDEX)) {
      return { ok: false, reason: 'offer_exists' };
    }
    throw err;
  }
}

/**
 * Where an ask stands in the order Hale's texts about it reached the parent. `lastAskedSeq`
 * is drawn when a send about it started and kept once that send went ({@link askStamp}):
 * higher started later, and no two are equal. Null: no text about it is known to have
 * reached them. Such an ask ranks below every ask whose text did, the newest offer first
 * among them, and is never the one a bare yes or no answers ({@link loadLastAskedOfferId}).
 */
export interface AskOrder {
  lastAskedSeq: number | null;
  createdAt: Date;
}

/** Sorts asks by {@link AskOrder}, the one whose text reached the parent last first. */
export function byAskedLast(a: AskOrder, b: AskOrder): number {
  if (a.lastAskedSeq !== null && b.lastAskedSeq !== null) return b.lastAskedSeq - a.lastAskedSeq;
  if (a.lastAskedSeq !== null) return -1;
  if (b.lastAskedSeq !== null) return 1;
  return b.createdAt.getTime() - a.createdAt.getTime();
}

/** {@link byAskedLast} in SQL, for `orderBy(...ASKED_LAST_FIRST)`. */
export const ASKED_LAST_FIRST = [
  sql`${schema.authorizedSignupOffers.lastAskedSeq} desc nulls last`,
  desc(schema.authorizedSignupOffers.createdAt),
] as const;

/** The asks one text is about, all made the parent it goes to. */
export interface AskedAbout {
  familyId: string;
  parentUserId: string;
  offerIds: readonly string[];
}

/** What keeping a send's ask number came to. Everything but `stamped` is logged by name. */
export type AskStampOutcome = 'stamped' | 'ask_order_uncertain' | 'ask_order_unmarked';

/**
 * Brackets the one transport call that carries a text about sign-up asks. Run it right
 * before that call; run what it returns once the transport accepted the text, and never
 * when the send failed.
 */
export type SendStamp = () => Promise<() => Promise<AskStampOutcome>>;

/**
 * The stamp for a text about these asks (the offer, a question back, a notice, a receipt).
 * Before the transport call it draws the next number from `authorized_signup_ask_seq`, so
 * asks rank by when their sends started, never by a clock: a turn and a sweep each carry the
 * time they began, and one sweep texting two asks has one time for both. Once the transport
 * took the text, the number is kept on each ask ({@link keepAskNumber}), so a text that never
 * went cannot take the parent's bare answer.
 *
 * Residual (minor): two sends to one parent whose transport calls overlap rank by which
 * started first, though the carrier may deliver the other first. The window is one carrier
 * call, and both texts are Hale's about the parent's own asks.
 */
export function askStamp(database: Database, asks: AskedAbout): SendStamp {
  return async () => {
    let seq: number | null = null;
    try {
      seq = await drawAskNumber(database);
    } catch (err) {
      console.error(
        { outcome: 'signup_ask_number_undrawn', err: err instanceof Error ? err.name : 'unknown' },
        'signup asks: no ask number before the send',
      );
    }
    return () => keepAskNumber(database, asks, seq);
  };
}

async function drawAskNumber(database: Database): Promise<number> {
  const result = (await database.execute(
    sql`select nextval(${schema.authorizedSignupAskSeq.seqName}::regclass)::text as seq`,
  )) as unknown;
  // postgres-js returns the rows as an array; pglite wraps them in `{ rows }`.
  const rows = Array.isArray(result) ? result : (result as { rows?: unknown }).rows;
  const seq = Array.isArray(rows)
    ? Number((rows[0] as { seq?: unknown } | undefined)?.seq)
    : Number.NaN;
  if (!Number.isSafeInteger(seq)) throw new Error('signup asks: unreadable ask number');
  return seq;
}

/**
 * The text went: keep its number on each ask (never lowering one a later-started send
 * kept), and clear a standing "order uncertain" row older than it, in one transaction.
 * Retried once. When it still fails, or no number was drawn, the order on file is wrong:
 * an older ask would take the bare answer to the text the parent just got. That fails
 * closed ({@link askOrderUncertain}). Never throws: the parent already has the text.
 */
async function keepAskNumber(
  database: Database,
  asks: AskedAbout,
  seq: number | null,
): Promise<AskStampOutcome> {
  let failure: unknown = null;
  if (seq !== null) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await database.transaction(async (rawTx) => {
          const tx = rawTx as unknown as Database;
          const offers = schema.authorizedSignupOffers;
          const uncertain = schema.authorizedSignupAskOrderUncertain;
          await tx
            .update(offers)
            .set({
              lastAskedSeq: sql`greatest(${offers.lastAskedSeq}, ${seq}::bigint)`,
              lastAskedAt: sql`clock_timestamp()`,
            })
            .where(
              and(
                inArray(offers.id, [...asks.offerIds]),
                eq(offers.familyId, asks.familyId),
                eq(offers.parentUserId, asks.parentUserId),
              ),
            );
          await tx
            .delete(uncertain)
            .where(
              and(
                eq(uncertain.familyId, asks.familyId),
                eq(uncertain.parentUserId, asks.parentUserId),
                lt(uncertain.failedSeq, seq),
              ),
            );
        });
        return 'stamped';
      } catch (err) {
        failure = err;
      }
    }
  }
  return askOrderUncertain(database, asks, seq, failure);
}

/**
 * A text about the parent's asks went and its number was not kept. Writes (or bumps) the
 * parent's "order uncertain" row, which holds every bare answer of theirs unbound until a
 * number drawn after this one is kept ({@link loadLastAskedOfferId}). An undrawn number is
 * marked by one drawn now, after the send. A repeat before then pages ops; a row that could
 * not be written pages at once, since nothing then holds their bare answer.
 */
async function askOrderUncertain(
  database: Database,
  asks: AskedAbout,
  seq: number | null,
  failure: unknown,
): Promise<AskStampOutcome> {
  const uncertain = schema.authorizedSignupAskOrderUncertain;
  const err = failure instanceof Error ? failure.name : seq === null ? 'undrawn' : 'unknown';
  let failures: number;
  try {
    const [row] = await database
      .insert(uncertain)
      .values({
        familyId: asks.familyId,
        parentUserId: asks.parentUserId,
        failedSeq:
          seq === null ? sql`nextval(${schema.authorizedSignupAskSeq.seqName}::regclass)` : seq,
      })
      .onConflictDoUpdate({
        target: [uncertain.familyId, uncertain.parentUserId],
        set: {
          failedSeq: sql`greatest(${uncertain.failedSeq}, excluded.failed_seq)`,
          failures: sql`${uncertain.failures} + 1`,
          updatedAt: sql`now()`,
        },
      })
      .returning({ failures: uncertain.failures });
    if (!row) throw new Error('signup asks: the order-uncertain row returned nothing');
    failures = row.failures;
  } catch (markErr) {
    console.error(
      {
        outcome: 'signup_ask_order_unmarked',
        err,
        markErr: markErr instanceof Error ? markErr.name : 'unknown',
      },
      'signup asks: a text went, its ask number was not kept, and nothing holds the bare answer',
    );
    await pageOps(database, { site: 'signup_ask_order_unmarked', facts: {} });
    return 'ask_order_unmarked';
  }
  console.error(
    { outcome: 'signup_ask_order_uncertain', failures, err },
    'signup asks: a text went and its ask number was not kept - bare answers bind nothing',
  );
  if (failures > 1) await pageOps(database, { site: 'signup_ask_order_uncertain', facts: {} });
  return 'ask_order_uncertain';
}

/**
 * The ask whose text reached this parent last, whatever its status now: the offer, or a later
 * question back, notice or receipt about it ({@link AskOrder}). Null when none of Hale's texts
 * about their asks is known to have reached them: an offer whose text never went is not it.
 * Null too while their order is uncertain (a text went whose number was not kept), so no
 * bare answer binds until a later one is. An approved, running or finished ask can be it, so
 * a bare yes after its login ask or receipt is never handed to an older ask still waiting on
 * one.
 */
export async function loadLastAskedOfferId(
  database: Database,
  input: { familyId: string; parentUserId: string },
): Promise<string | null> {
  const uncertain = schema.authorizedSignupAskOrderUncertain;
  const [held] = await database
    .select({ failures: uncertain.failures })
    .from(uncertain)
    .where(
      and(eq(uncertain.familyId, input.familyId), eq(uncertain.parentUserId, input.parentUserId)),
    )
    .limit(1);
  if (held) {
    console.info(
      { outcome: 'signup_ask_order_uncertain_held', failures: held.failures },
      'signup asks: the order is uncertain - no ask takes a bare answer',
    );
    return null;
  }
  const offers = schema.authorizedSignupOffers;
  const [row] = await database
    .select({ id: offers.id })
    .from(offers)
    .where(
      and(
        eq(offers.familyId, input.familyId),
        eq(offers.parentUserId, input.parentUserId),
        isNotNull(offers.lastAskedSeq),
      ),
    )
    .orderBy(desc(offers.lastAskedSeq))
    .limit(1);
  return row?.id ?? null;
}

/** A pending ask with the public facts a parent could name it by, and its {@link AskOrder}. */
export interface PendingSignupOffer extends SignupOffer, AskOrder {
  activityLabel: string | null;
  providerHost: string;
}

/** Every pending ask of the family, in {@link AskOrder}. Several can be open at once. */
export async function loadPendingOffers(
  database: Database,
  familyId: string,
): Promise<PendingSignupOffer[]> {
  const offers = schema.authorizedSignupOffers;
  const rows = await database
    .select()
    .from(offers)
    .where(and(eq(offers.familyId, familyId), eq(offers.status, 'pending')))
    .orderBy(...ASKED_LAST_FIRST);
  return rows.flatMap((row) =>
    row.familyId !== familyId || row.status !== 'pending'
      ? []
      : [
          {
            id: row.id,
            familyId: row.familyId,
            childId: row.childId,
            parentUserId: row.parentUserId,
            activityKey: row.activityKey,
            registrationUrl: row.registrationUrl,
            sessions: row.sessions,
            approvedPriceCents: row.approvedPriceCents,
            activityLabel: row.activityLabel,
            providerHost: row.providerHost,
            lastAskedSeq: row.lastAskedSeq,
            createdAt: row.createdAt,
          },
        ],
  );
}

/** The family's pending ask with this id, or null when it is not one. */
export async function loadPendingOffer(
  database: Database,
  familyId: string,
  offerId: string,
): Promise<SignupOffer | null> {
  const [row] = await database
    .select({
      id: schema.authorizedSignupOffers.id,
      familyId: schema.authorizedSignupOffers.familyId,
      childId: schema.authorizedSignupOffers.childId,
      parentUserId: schema.authorizedSignupOffers.parentUserId,
      activityKey: schema.authorizedSignupOffers.activityKey,
      registrationUrl: schema.authorizedSignupOffers.registrationUrl,
      sessions: schema.authorizedSignupOffers.sessions,
      approvedPriceCents: schema.authorizedSignupOffers.approvedPriceCents,
      status: schema.authorizedSignupOffers.status,
    })
    .from(schema.authorizedSignupOffers)
    .where(
      and(
        eq(schema.authorizedSignupOffers.familyId, familyId),
        eq(schema.authorizedSignupOffers.status, 'pending'),
        eq(schema.authorizedSignupOffers.id, offerId),
      ),
    )
    .limit(1);
  if (!row || row.familyId !== familyId || row.status !== 'pending' || row.id !== offerId) {
    return null;
  }
  return {
    id: row.id,
    familyId: row.familyId,
    childId: row.childId,
    parentUserId: row.parentUserId,
    activityKey: row.activityKey,
    registrationUrl: row.registrationUrl,
    sessions: row.sessions,
    approvedPriceCents: row.approvedPriceCents,
  };
}

export async function markOffer(
  database: Database,
  input: {
    offerId: string;
    familyId: string;
    from: 'pending' | 'submitting';
    status: 'submitting' | 'completed' | 'handed_back';
    sessionId?: string | null;
    messageId?: string | null;
    now: Date;
  },
): Promise<boolean> {
  const patch: {
    status: string;
    updatedAt: Date;
    authorizedSessionId?: string | null;
    authorizingMessageId?: string | null;
  } = { status: input.status, updatedAt: input.now };
  if (input.sessionId !== undefined) patch.authorizedSessionId = input.sessionId;
  if (input.messageId !== undefined) patch.authorizingMessageId = input.messageId;
  try {
    const rows = await database
      .update(schema.authorizedSignupOffers)
      .set(patch)
      .where(
        and(
          eq(schema.authorizedSignupOffers.id, input.offerId),
          eq(schema.authorizedSignupOffers.familyId, input.familyId),
          eq(schema.authorizedSignupOffers.status, input.from),
        ),
      )
      .returning({ id: schema.authorizedSignupOffers.id });
    return rows.length > 0;
  } catch (err) {
    // Another registration of this family is already running: not moved.
    if (isOneSubmittingViolation(err)) return false;
    throw err;
  }
}

const ONE_SUBMITTING_INDEX = 'authorized_signup_offers_one_submitting';
/** 0230's index: one pending ask per family and site. */
const ONE_PENDING_PER_HOST_INDEX = 'authorized_signup_offers_one_pending_per_host';

/** The database refused a second running registration for one family (0206's index). */
export function isOneSubmittingViolation(err: unknown): boolean {
  return isUniqueViolation(err, ONE_SUBMITTING_INDEX);
}

function isUniqueViolation(err: unknown, index: string): boolean {
  const seen = new Set<unknown>();
  let current: unknown = err;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    const pg = current as { code?: unknown; constraint?: unknown; constraint_name?: unknown };
    if (
      pg.code === '23505' &&
      (pg.constraint === index || pg.constraint_name === index || current.message.includes(index))
    ) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export async function loadSignupIdentity(
  database: Database,
  input: { familyId: string; childId: string; parentUserId: string; now: Date },
): Promise<SignupIdentity | null> {
  const [child] = await database
    .select({
      name: schema.children.name,
      lastName: schema.children.lastName,
      dateOfBirth: schema.children.dateOfBirth,
      dobPrecision: schema.children.dobPrecision,
      familyId: schema.children.familyId,
    })
    .from(schema.children)
    .where(and(eq(schema.children.id, input.childId), eq(schema.children.familyId, input.familyId)))
    .limit(1);
  if (!child || child.familyId !== input.familyId) return null;
  const [parent] = await database
    .select({ name: schema.users.name, email: schema.users.email })
    .from(schema.users)
    .where(eq(schema.users.id, input.parentUserId))
    .limit(1);
  const [family] = await database
    .select({ postalCode: schema.families.postalCode, id: schema.families.id })
    .from(schema.families)
    .where(eq(schema.families.id, input.familyId))
    .limit(1);
  if (!family || family.id !== input.familyId) return null;
  const teenager = deriveStage(child.dateOfBirth, input.now) === 'teenager';
  return {
    childFirstName: child.name,
    childLastName: child.lastName,
    childDob: child.dobPrecision === 'exact' ? child.dateOfBirth : null, // derived dates are never typed
    parentFirstName: parent?.name ?? null,
    parentEmail: parent?.email ?? null,
    postalCode: family.postalCode,
    teenager,
  };
}

export async function loadBusy(database: Database, familyId: string): Promise<BusyInterval[]> {
  const rows = await database
    .select({
      startAt: schema.parentCalendarBlocks.startAt,
      endAt: schema.parentCalendarBlocks.endAt,
      familyId: schema.parentCalendarBlocks.familyId,
    })
    .from(schema.parentCalendarBlocks)
    .where(eq(schema.parentCalendarBlocks.familyId, familyId));
  return rows.flatMap((row) => {
    if (row.familyId !== familyId || !row.startAt || !row.endAt) return [];
    return [{ startsAt: row.startAt.toISOString(), endsAt: row.endAt.toISOString() }];
  });
}

/**
 * The Browser Use session's full cost (model, search, browser time, proxy),
 * read from GET /sessions/{id}/cost after its browser stopped. A run's own
 * totalCostUsd covers the model only.
 */
export async function recordBrowserUseCost(
  database: Database,
  input: { offerId: string; familyId: string; sessionCostUsd: string; now: Date },
): Promise<void> {
  if (!/^\d+(\.\d+)?$/.test(input.sessionCostUsd)) return;
  await database
    .update(schema.authorizedSignupOffers)
    .set({ browserUseCostUsd: input.sessionCostUsd, updatedAt: input.now })
    .where(
      and(
        eq(schema.authorizedSignupOffers.id, input.offerId),
        eq(schema.authorizedSignupOffers.familyId, input.familyId),
      ),
    );
}

/**
 * Everything Browser Use registrations have cost or hold reserved, across every
 * family: the sum of `browser_use_cost_usd` (migration 0175). A run in flight
 * or handed to a parent with a live browser counts at its reserved allowance
 * until its real session cost replaces it.
 */
export async function browserUseRegistrationSpendUsd(database: Database): Promise<number> {
  const [row] = await database
    .select({
      total: sql<
        string | null
      >`coalesce(sum(${schema.authorizedSignupOffers.browserUseCostUsd}), 0)`,
    })
    .from(schema.authorizedSignupOffers);
  // Fail closed: a total that cannot be read counts as unlimited spend, so no
  // Browser Use run starts on an unknown balance.
  if (!row || row.total === null || row.total === undefined) return Number.POSITIVE_INFINITY;
  const total = Number(row.total);
  return Number.isFinite(total) && total >= 0 ? total : Number.POSITIVE_INFINITY;
}

/** Serializes reservations across every instance (any fixed 64-bit key). */
const REGISTRATION_RESERVE_LOCK = 7_340_025;

/**
 * Atomically holds `allowanceUsd` against the global registration reserve on
 * this offer before a Browser Use run starts. Concurrent signups serialize on a
 * transaction-scoped advisory lock, so two runs cannot both claim the last
 * allowance. Returns false, writing nothing, when the allowance does not fit.
 */
export async function reserveBrowserUseAllowance(
  database: Database,
  input: { offerId: string; familyId: string; allowanceUsd: number; reserveUsd: number; now: Date },
): Promise<{ ok: boolean; spentUsd: number }> {
  return database.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Database;
    await tx.execute(sql`select pg_advisory_xact_lock(${REGISTRATION_RESERVE_LOCK})`);
    const spentUsd = await browserUseRegistrationSpendUsd(tx);
    if (spentUsd + input.allowanceUsd > input.reserveUsd) return { ok: false, spentUsd };
    await tx
      .update(schema.authorizedSignupOffers)
      .set({ browserUseCostUsd: input.allowanceUsd.toFixed(6), updatedAt: input.now })
      .where(
        and(
          eq(schema.authorizedSignupOffers.id, input.offerId),
          eq(schema.authorizedSignupOffers.familyId, input.familyId),
        ),
      );
    return { ok: true, spentUsd };
  });
}
