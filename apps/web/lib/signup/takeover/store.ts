import { type AuthorizedSignupPlanResume, type Database, schema } from '@hale/db';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { hashLoginCode } from '../login-link/code';
import { type TakeoverLinkLookup, cardLiveView, lookupTakeoverLink } from '../login-link/store';
import { planLapse, writePlanAudit } from '../plan/store';
import { type TakeoverPurpose, isTakeoverPurpose } from './purpose';

/** VIL-718 · where a plan stands while the parent holds its takeover link. */
export type TakeoverToken = Extract<AuthorizedSignupPlanResume, { phase: 'takeover' }>;

/**
 * The plan stays `submitting` (one family, one session at a time) and no sweep picks it up
 * until the link closes: the lease runs to the link's own end. A done clears the lease, so
 * the next sweep picks the session back up at once. False when the plan is no longer this
 * sweep's to park, or the parent has taken it back.
 */
export async function parkPlanForTakeover(
  database: Database,
  input: { offerId: string; familyId: string; token: TakeoverToken; now: Date },
): Promise<boolean> {
  const offers = schema.authorizedSignupOffers;
  const rows = await database
    .update(offers)
    .set({
      planResume: input.token,
      planLeaseUntil: new Date(input.token.expiresAt),
      updatedAt: input.now,
    })
    .where(
      and(
        eq(offers.id, input.offerId),
        eq(offers.familyId, input.familyId),
        eq(offers.status, 'submitting'),
        isNull(offers.planCancelRequestedAt),
      ),
    )
    .returning({ id: offers.id });
  return rows.length > 0;
}

/** The token's state as one jsonb merge, so a done and a lapse can never both land. */
function stamped(field: 'doneAt' | 'lapsedAt', now: Date) {
  const offers = schema.authorizedSignupOffers;
  return sql`${offers.planResume} || ${JSON.stringify({ [field]: now.toISOString() })}::jsonb`;
}

/** A takeover still waiting on the parent: neither done nor lapsed. */
function waiting(input: { offerId: string; familyId: string; loginLinkId: string }) {
  const offers = schema.authorizedSignupOffers;
  return and(
    eq(offers.id, input.offerId),
    eq(offers.familyId, input.familyId),
    eq(offers.status, 'submitting'),
    sql`${offers.planResume}->>'phase' = 'takeover'`,
    sql`${offers.planResume}->>'loginLinkId' = ${input.loginLinkId}`,
    sql`(${offers.planResume}->>'doneAt') is null`,
    sql`(${offers.planResume}->>'lapsedAt') is null`,
  );
}

/**
 * The live view behind an open takeover card, for the page's POST only. It hands over the
 * browser itself, so it opens only while the plan still waits on this card, nobody has
 * stopped it and the parent's yes still stands. A refusal leaves the card to the sweep, which
 * closes it and lets the browser go.
 */
export async function takeoverLiveView(
  database: Database,
  code: string,
  now: Date,
): Promise<
  | { ok: true; link: Extract<TakeoverLinkLookup, { ok: true }>; liveViewUrl: string }
  | { ok: false; reason: 'unknown' | 'expired' | 'used' | 'gone' }
> {
  const link = await lookupTakeoverLink(database, code, now);
  if (!link.ok) return link;
  const offers = schema.authorizedSignupOffers;
  const [plan] = await database
    .select({ id: offers.id })
    .from(offers)
    .where(
      and(
        waiting({ offerId: link.offerId, familyId: link.familyId, loginLinkId: link.id }),
        isNull(offers.planCancelRequestedAt),
      ),
    )
    .limit(1);
  if (!plan || (await planLapse(database, link)) !== null) return { ok: false, reason: 'gone' };
  const liveViewUrl = await cardLiveView(database, link.id);
  if (!liveViewUrl) return { ok: false, reason: 'gone' };
  return { ok: true, link, liveViewUrl };
}

class TakeoverNotWaiting extends Error {
  override name = 'TakeoverNotWaiting';
}

export type FinishTakeover =
  | { ok: true; offerId: string; familyId: string; providerHost: string; purpose: TakeoverPurpose }
  | { ok: false; reason: 'unknown' | 'expired' | 'used' | 'not_waiting' };

/**
 * The parent tapped done. In one transaction the card is spent (single use), the plan's token
 * is stamped `doneAt` with its lease cleared, so the next minute's sweep queues the next turn
 * of the same session, and the audit row is written (rule #6): the host and the step. All or
 * nothing: a card whose plan already lapsed, was let go or was taken back is not spent here
 * and answers `not_waiting`, and neither is a card whose parent's yes no longer stands.
 */
export async function finishTakeover(
  database: Database,
  input: { code: string; now: Date },
): Promise<FinishTakeover> {
  const link = await lookupTakeoverLink(database, input.code, input.now);
  if (!link.ok) return link;
  const purpose = link.purpose.takeover;
  if (!isTakeoverPurpose(purpose)) return { ok: false, reason: 'unknown' };
  if ((await planLapse(database, link)) !== null) return { ok: false, reason: 'not_waiting' };
  const links = schema.providerLoginLinks;
  const offers = schema.authorizedSignupOffers;
  try {
    await database.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Database;
      const spent = await tx
        .update(links)
        .set({ consumedAt: input.now, browserHandleCiphertext: null, browserId: null })
        .where(
          and(
            eq(links.id, link.id),
            eq(links.tokenHash, hashLoginCode(input.code)),
            isNull(links.consumedAt),
            gt(links.expiresAt, input.now),
          ),
        )
        .returning({ id: links.id });
      if (spent.length === 0) throw new TakeoverNotWaiting('card already spent');
      const resumed = await tx
        .update(offers)
        .set({
          planResume: stamped('doneAt', input.now),
          planLeaseUntil: null,
          updatedAt: input.now,
        })
        .where(
          and(
            waiting({ offerId: link.offerId, familyId: link.familyId, loginLinkId: link.id }),
            isNull(offers.planCancelRequestedAt),
          ),
        )
        .returning({ id: offers.id });
      if (resumed.length === 0) throw new TakeoverNotWaiting('plan not waiting');
      await writePlanAudit(tx, {
        familyId: link.familyId,
        actor: link.parentUserId,
        offerId: link.offerId,
        after: { step: 'plan_takeover_done', purpose, host: link.providerHost },
      });
    });
  } catch (err) {
    if (err instanceof TakeoverNotWaiting) return { ok: false, reason: 'not_waiting' };
    throw err;
  }
  return {
    ok: true,
    offerId: link.offerId,
    familyId: link.familyId,
    providerHost: link.providerHost,
    purpose,
  };
}

/**
 * The sweep found the takeover's link ran out before a done. Stamps `lapsedAt`, spends the
 * card and writes the audit row in one transaction, so a sweep that dies right after leaves a
 * lapse the next sweep can finish. False when the parent's done landed first: that plan is
 * resumed, not ended.
 */
export async function lapseTakeover(
  database: Database,
  input: {
    offerId: string;
    familyId: string;
    loginLinkId: string;
    actor: string;
    after: Record<string, unknown>;
    now: Date;
  },
): Promise<boolean> {
  const links = schema.providerLoginLinks;
  const offers = schema.authorizedSignupOffers;
  return database.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Database;
    const lapsed = await tx
      .update(offers)
      .set({ planResume: stamped('lapsedAt', input.now), updatedAt: input.now })
      .where(waiting(input))
      .returning({ id: offers.id });
    if (lapsed.length === 0) return false;
    await tx
      .update(links)
      .set({ consumedAt: input.now, browserHandleCiphertext: null, browserId: null })
      .where(
        and(
          eq(links.id, input.loginLinkId),
          eq(links.familyId, input.familyId),
          isNull(links.consumedAt),
        ),
      );
    await writePlanAudit(tx, {
      familyId: input.familyId,
      actor: input.actor,
      offerId: input.offerId,
      after: input.after,
    });
    return true;
  });
}

/**
 * Ends this sweep's hold on a parked plan whose done landed while the sweep had claimed it:
 * the next sweep picks the session back up at once.
 */
export async function letGoOfTakeover(
  database: Database,
  input: { offerId: string; familyId: string },
): Promise<void> {
  const offers = schema.authorizedSignupOffers;
  await database
    .update(offers)
    .set({ planLeaseUntil: null })
    .where(
      and(
        eq(offers.id, input.offerId),
        eq(offers.familyId, input.familyId),
        eq(offers.status, 'submitting'),
      ),
    );
}
