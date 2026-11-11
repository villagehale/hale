import { type Database, schema } from '@hale/db';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { readParentLanguage } from '~/lib/channel/parent-language';
import { signupProviderHost } from '../consent';
import { providerCredentialsEnabled } from '../credentials/flag';
import { mintFreshLoginLink } from '../login-link/store';
import type { SiteChoice, SiteFees } from '../site-choices';
import type { SignupSession } from '../types';
import { type PlanNoticePart, asBubbles, withLinkBubbles } from './bubbles';
import { parentTimeZone } from './conversation';
import { writePlanAudit } from './store';
import { planOpensAtLocal } from './writer';

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
  | 'ask_dob';

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

/** One notice, in order. The login link is its own part, so the deliver can send it as a card. */
export type PlanPrepDeliver = (input: {
  familyId: string;
  parentUserId: string;
  offerId: string;
  kind: PlanNoticeKind;
  parts: readonly PlanNoticePart[];
  now: Date;
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

/** The plan's first choice: what the login is for. */
export function firstChoiceLabel(
  sessions: readonly SignupSession[],
  choiceIds: readonly string[] | null,
): string | null {
  const first = (choiceIds ?? [])[0];
  return sessions.find((session) => session.id === first)?.label ?? null;
}

/**
 * Whether the run at the open can already sign in: a saved login that is not stale, or a
 * provider session that lasts past the open. The run reads the same two (run.ts).
 */
async function loginReadyForOpen(
  database: Database,
  input: { familyId: string; providerHost: string; opensAt: Date },
): Promise<boolean> {
  if (providerCredentialsEnabled()) {
    const creds = schema.providerSignupCredentials;
    const [saved] = await database
      .select({ id: creds.id })
      .from(creds)
      .where(
        and(
          eq(creds.familyId, input.familyId),
          eq(creds.providerHost, input.providerHost),
          isNull(creds.staleAt),
        ),
      )
      .limit(1);
    if (saved) return true;
  }
  const sessions = schema.providerSignupSessions;
  const [session] = await database
    .select({ id: sessions.id })
    .from(sessions)
    .where(
      and(
        eq(sessions.familyId, input.familyId),
        eq(sessions.providerHost, input.providerHost),
        gt(sessions.expiresAt, input.opensAt),
      ),
    )
    .limit(1);
  return Boolean(session);
}

function nextKind(
  sent: ReadonlySet<string>,
  opensAt: Date,
  now: Date,
  loginReady: boolean,
): PlanPrepKind | null {
  if (!loginReady && !sent.has('login_ask')) return 'login_ask';
  if (!loginReady && !sent.has('account_prep')) return 'account_prep';
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
 * Each link replaces any open one for the host, and neither ask goes while the
 * run can already sign in.
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
    const asksLeft = !sent.has('login_ask') || !sent.has('account_prep');
    const loginReady =
      asksLeft &&
      (await loginReadyForOpen(database, {
        familyId: offer.familyId,
        providerHost: host,
        opensAt: offer.planOpensAt,
      }));
    const kind = nextKind(sent, offer.planOpensAt, sweep.now, loginReady);
    if (!kind) continue;
    const [child] = await database
      .select({ name: schema.children.name })
      .from(schema.children)
      .where(eq(schema.children.id, offer.childId))
      .limit(1);
    const sessionLabel = firstChoiceLabel(offer.sessions, offer.planChoiceIds);
    const opensAt = planOpensAtLocal(
      offer.planOpensAt,
      await parentTimeZone(database, offer.parentUserId),
    );
    const facts: PlanPrepFacts = {
      kind,
      childFirstName: child?.name ?? null,
      opensAt,
      host,
      language: await readParentLanguage(database, {
        familyId: offer.familyId,
        parentUserId: offer.parentUserId,
      }),
      sessionLabel,
    };
    const written = asBubbles(await deps.writer.write(facts));
    if (!written) {
      notices.push({ offerId: offer.id, kind, sent: false });
      continue;
    }
    const link =
      kind === 'login_ask' || kind === 'account_prep'
        ? (
            await mintFreshLoginLink(database, {
              familyId: offer.familyId,
              parentUserId: offer.parentUserId,
              offerId: offer.id,
              providerHost: host,
              purpose: { kind, sessionLabel, opensAt },
              now: sweep.now,
            })
          ).url
        : null;
    const delivered = await deps.deliver({
      familyId: offer.familyId,
      parentUserId: offer.parentUserId,
      offerId: offer.id,
      kind,
      parts: withLinkBubbles(written, link),
      now: sweep.now,
    });
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

/** One event-driven notice (rejected password, mismatched options). Each part is its own send. */
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
  const delivered = await deps.deliver({
    familyId: input.familyId,
    parentUserId: input.parentUserId,
    offerId: input.offerId,
    kind: input.kind,
    parts: withLinkBubbles(written, input.link ?? null, input.linkAfter ?? 0),
    now: input.now,
  });
  if (!delivered) return false;
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
