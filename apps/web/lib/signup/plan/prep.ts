import { type Database, schema } from '@hale/db';
import { and, eq, gt } from 'drizzle-orm';
import { signupProviderHost } from '../consent';
import { mintLoginLink } from '../login-link/store';
import type { SiteChoice, SiteFees } from '../site-choices';
import { markOfferAsked } from '../store';
import { asBubbles, withLinkBubbles } from './bubbles';
import { writePlanAudit } from './store';

/** Reminder fires 30 minutes before the open (6:30 for a 7:00 open). */
export const PRE_OPEN_LEAD_MS = 30 * 60_000;

export const PLAN_PREP_KINDS = ['login_ask', 'account_prep', 'pre_open'] as const;
export type PlanPrepKind = (typeof PLAN_PREP_KINDS)[number];

export type PlanNoticeKind =
  | PlanPrepKind
  | 'password_rejected'
  | 'options_mismatch'
  | 'seats'
  | 'receipt'
  | 'waitlist'
  | 'ask_dob'
  /** Recorded by the text that asks the parent whether Hale may tick the plan's waiver. */
  | 'ask_waiver';

export interface PlanPrepFacts {
  kind: PlanNoticeKind;
  childFirstName: string | null;
  opensAt: { local: string; timeZone: string };
  host: string;
  language: string | null;
  loginStale?: boolean;
  passwordRejectionMessage?: string | null;
  passwordRule?: string | null;
  siteChoices?: readonly SiteChoice[] | null;
  askedStart?: string | null;
  sessionLabel?: string | null;
  fees?: SiteFees | null;
  confirmed?: boolean;
  joined?: boolean;
}

export interface PlanPrepWriter {
  write(facts: PlanPrepFacts): Promise<string | readonly string[] | null>;
}

export type PlanPrepDeliver = (input: {
  familyId: string;
  parentUserId: string;
  offerId: string;
  kind: PlanNoticeKind;
  body: string;
}) => Promise<boolean>;

export interface PlanPrepDeps {
  writer: PlanPrepWriter;
  deliver: PlanPrepDeliver;
}

export interface PlanPrepSummary {
  offerId: string;
  kind: PlanPrepKind;
  sent: boolean;
}

export async function hasPlanNotice(
  database: Database,
  offerId: string,
  kind: string,
): Promise<boolean> {
  const [row] = await database
    .select({ id: schema.providerLoginNotices.id })
    .from(schema.providerLoginNotices)
    .where(
      and(
        eq(schema.providerLoginNotices.offerId, offerId),
        eq(schema.providerLoginNotices.kind, kind),
      ),
    )
    .limit(1);
  return Boolean(row);
}

export async function recordPlanNotice(
  database: Database,
  input: {
    familyId: string;
    offerId: string;
    providerHost: string;
    kind: string;
    now: Date;
  },
): Promise<boolean> {
  try {
    await database.insert(schema.providerLoginNotices).values({
      familyId: input.familyId,
      offerId: input.offerId,
      providerHost: input.providerHost,
      kind: input.kind,
      sentAt: input.now,
    });
    return true;
  } catch {
    return false;
  }
}

function nextKind(sent: ReadonlySet<string>, opensAt: Date, now: Date): PlanPrepKind | null {
  if (!sent.has('login_ask')) return 'login_ask';
  if (!sent.has('account_prep')) return 'account_prep';
  if (!sent.has('pre_open') && now.getTime() >= opensAt.getTime() - PRE_OPEN_LEAD_MS) {
    return 'pre_open';
  }
  return null;
}

/**
 * VIL-558 · the three parent texts that must exist before the open: the login
 * ask (with a /l/<code> link), account prep (create the provider account and
 * add the child as a family member, with a link), and the 30-minute reminder.
 * One kind per offer per sweep. Model-written; a failed draft sends nothing.
 */
export async function runDueSignupPlanPrep(
  database: Database,
  sweep: { now: Date },
  deps: PlanPrepDeps,
): Promise<{ notices: PlanPrepSummary[] }> {
  const offers = schema.authorizedSignupOffers;
  const rows = await database
    .select()
    .from(offers)
    .where(and(eq(offers.status, 'planned'), gt(offers.planOpensAt, sweep.now)));
  const notices: PlanPrepSummary[] = [];
  for (const offer of rows) {
    if (!offer.planOpensAt) continue;
    const host = signupProviderHost(offer.providerHost || new URL(offer.registrationUrl).hostname);
    const existing = await database
      .select({ kind: schema.providerLoginNotices.kind })
      .from(schema.providerLoginNotices)
      .where(eq(schema.providerLoginNotices.offerId, offer.id));
    const sent = new Set(existing.map((row) => row.kind));
    const kind = nextKind(sent, offer.planOpensAt, sweep.now);
    if (!kind) continue;
    const [child] = await database
      .select({ name: schema.children.name })
      .from(schema.children)
      .where(eq(schema.children.id, offer.childId))
      .limit(1);
    const facts: PlanPrepFacts = {
      kind,
      childFirstName: child?.name ?? null,
      opensAt: {
        local: offer.planOpensAt.toISOString(),
        timeZone: 'UTC',
      },
      host,
      language: null,
    };
    const written = asBubbles(await deps.writer.write(facts));
    if (!written) {
      notices.push({ offerId: offer.id, kind, sent: false });
      continue;
    }
    let bubbles = written;
    if (kind === 'login_ask' || kind === 'account_prep') {
      const minted = await mintLoginLink(database, {
        familyId: offer.familyId,
        parentUserId: offer.parentUserId,
        offerId: offer.id,
        providerHost: host,
        purpose: { host, kind, childFirstName: child?.name ?? null },
        now: sweep.now,
      });
      bubbles = withLinkBubbles(written, minted.url);
    }
    let delivered = true;
    for (const body of bubbles) {
      const ok = await deps.deliver({
        familyId: offer.familyId,
        parentUserId: offer.parentUserId,
        offerId: offer.id,
        kind,
        body,
      });
      if (!ok) {
        delivered = false;
        break;
      }
    }
    if (!delivered) {
      notices.push({ offerId: offer.id, kind, sent: false });
      continue;
    }
    await recordPlanNotice(database, {
      familyId: offer.familyId,
      offerId: offer.id,
      providerHost: host,
      kind,
      now: sweep.now,
    });
    await markOfferAsked(database, { familyId: offer.familyId, offerId: offer.id, at: sweep.now });
    await writePlanAudit(database, {
      familyId: offer.familyId,
      actor: offer.parentUserId,
      offerId: offer.id,
      after: { step: `plan_${kind}`, host },
    });
    notices.push({ offerId: offer.id, kind, sent: true });
  }
  return { notices };
}

/** One event-driven notice (rejected password, mismatched options). Each bubble is its own send. */
export async function sendSignupPlanNotice(
  database: Database,
  input: {
    familyId: string;
    parentUserId: string;
    offerId: string;
    providerHost: string;
    kind: PlanNoticeKind;
    facts: PlanPrepFacts;
    link?: string | null;
    linkAfter?: number;
    now: Date;
  },
  deps: PlanPrepDeps,
): Promise<boolean> {
  const written = asBubbles(await deps.writer.write(input.facts));
  if (!written) return false;
  const bubbles = withLinkBubbles(written, input.link ?? null, input.linkAfter ?? 0);
  for (const body of bubbles) {
    const ok = await deps.deliver({
      familyId: input.familyId,
      parentUserId: input.parentUserId,
      offerId: input.offerId,
      kind: input.kind,
      body,
    });
    if (!ok) return false;
  }
  await markOfferAsked(database, {
    familyId: input.familyId,
    offerId: input.offerId,
    at: input.now,
  });
  await writePlanAudit(database, {
    familyId: input.familyId,
    actor: input.parentUserId,
    offerId: input.offerId,
    after: { step: `plan_${input.kind}`, host: input.providerHost },
  });
  return true;
}

/** Planned offers whose 30-minute reminder is due, for tests. */
export function preOpenDueAt(opensAt: Date): Date {
  return new Date(opensAt.getTime() - PRE_OPEN_LEAD_MS);
}

export function plannedOfferDueForPrep(
  offer: { status: string; planOpensAt: Date | null },
  now: Date,
): boolean {
  return offer.status === 'planned' && offer.planOpensAt !== null && offer.planOpensAt > now;
}
