import { type Database, schema } from '@hale/db';
import { deriveStage } from '@hale/types';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
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

/** When Hale last asked the parent about an offer: its last text about it, else the offer. */
export function offerAskedAt(row: { lastAskedAt: Date | null; createdAt: Date }): Date {
  return row.lastAskedAt ?? row.createdAt;
}

/** {@link offerAskedAt} in SQL, to order offers most recently asked first. */
export const OFFER_ASKED_AT = sql`coalesce(${schema.authorizedSignupOffers.lastAskedAt}, ${schema.authorizedSignupOffers.createdAt})`;

/**
 * Hale just sent this parent a text about this ask: a bare yes or no of theirs answers it
 * next. Called once the text went out, never before, so a question that never reached them
 * cannot take their next answer.
 */
export async function markOfferAsked(
  database: Database,
  input: { familyId: string; offerId: string; at: Date },
): Promise<void> {
  const offers = schema.authorizedSignupOffers;
  await database
    .update(offers)
    .set({ lastAskedAt: input.at })
    .where(and(eq(offers.id, input.offerId), eq(offers.familyId, input.familyId)));
}

/**
 * The ask Hale texted this parent about last, whatever its status now: the offer, or a later
 * question back, notice or receipt about it ({@link offerAskedAt}). Null when Hale made them
 * none. An approved, running or finished ask can be it, so a bare yes after its login ask or
 * receipt is never handed to an older ask still waiting on one.
 */
export async function loadLastAskedOfferId(
  database: Database,
  input: { familyId: string; parentUserId: string },
): Promise<string | null> {
  const offers = schema.authorizedSignupOffers;
  const [row] = await database
    .select({ id: offers.id })
    .from(offers)
    .where(and(eq(offers.familyId, input.familyId), eq(offers.parentUserId, input.parentUserId)))
    .orderBy(desc(OFFER_ASKED_AT), desc(offers.id))
    .limit(1);
  return row?.id ?? null;
}

/** A pending ask with the public facts a parent could name it by. */
export interface PendingSignupOffer extends SignupOffer {
  activityLabel: string | null;
  providerHost: string;
  /** {@link offerAskedAt}. */
  askedAt: Date;
}

/** Every pending ask of the family, most recently asked first. Several can be open at once. */
export async function loadPendingOffers(
  database: Database,
  familyId: string,
): Promise<PendingSignupOffer[]> {
  const offers = schema.authorizedSignupOffers;
  const rows = await database
    .select()
    .from(offers)
    .where(and(eq(offers.familyId, familyId), eq(offers.status, 'pending')))
    .orderBy(desc(OFFER_ASKED_AT));
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
            askedAt: offerAskedAt(row),
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
