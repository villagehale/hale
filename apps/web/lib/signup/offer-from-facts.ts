import { createHash } from 'node:crypto';
import { type Database, schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { readParentLanguage } from '~/lib/channel/parent-language';
import { resolveReplyClient } from '~/lib/channel/reply-copy/client';
import { pageOps } from '~/lib/monitoring/failure-page';
import { redactSignupAudit } from './audit';
import {
  type SignupOfferFacts,
  type SignupOfferWriter,
  createSignupOfferWriter,
} from './offer-writer';
import { parentTimeZone, replySessions } from './plan/conversation';
import { registrationPlanRunEnabled } from './plan/flag';
import { planModeFor } from './plan/towns';
import {
  type PlanReplyTerms,
  type PlanReplyWriter,
  createPlanReplyWriter,
  planOpensAtLocal,
  planReplyBody,
} from './plan/writer';
import { type ReplacedSignupOffer, recordSignupOffer } from './store';
import { childFor, prepareTermsAsk } from './terms/ask';
import { registrationPreflightEnabled } from './terms/flag';
import type { ProgramTermsDeps } from './terms/read-page';
import type { SignupSession } from './types';
import { registrationUrlAllowed } from './url';

/**
 * PRODUCTION CALLER for `recordSignupOffer` (VIL-470).
 *
 * Hale's AI writes the offer from facts Hale actually saw — an email, a
 * calendar, a flyer, or this chat — then the row is stored. Nothing here
 * interpolates a locked parent sentence, and a failed write does not fall
 * back to stock copy. The parent's yes is someone else's job (`runAuthorizedSignup`).
 */

export type OfferSignupReason =
  | 'no_facts'
  | 'url_refused'
  | 'child_missing'
  | 'unwritten'
  | 'offer_exists'
  | 'activity_key'
  | 'sessions'
  /** VIL-715 · the page's age band rules this child out: nothing is asked or stored. */
  | 'age_outside_band';

export type OfferSignupResult =
  | { ok: true; offerId: string; text: string; replaced: ReplacedSignupOffer[] }
  | { ok: false; reason: OfferSignupReason; ageBand?: string | null };

export interface OfferSignupInput {
  familyId: string;
  parentUserId: string;
  childId: string;
  now: Date;
  facts: Omit<SignupOfferFacts, 'childFirstName'> & { childFirstName?: string | null };
  /** VIL-558 · when registration opens, as Hale saw it. Null when it did not say. */
  planOpensAt?: Date | null;
  /** The program's public name as the page or the parent gave it. */
  activityLabel?: string | null;
  /** This parent's pending asks their own words this turn replaced (see recordSignupOffer). */
  supersede?: readonly string[];
}

export interface OfferSignupDeps {
  /** Undefined uses the reply model. Tests inject a writer. */
  writer?: SignupOfferWriter;
  /** The day-before plan's writer, for an offer Hale can carry out at the open. */
  planWriter?: PlanReplyWriter;
  /** Undefined uses `PLAN_AUTO_HOSTS`. */
  autoHosts?: readonly string[];
  /** VIL-715 · the page read before the ask. Undefined uses the live fetcher and model. */
  terms?: ProgramTermsDeps;
}

const KEY = /^[a-z0-9][a-z0-9._:-]{0,79}$/i;

/** Derived from the page Hale saw, never authored by the model. */
export function activityKeyFor(registrationUrl: string): string {
  const hash = createHash('sha256').update(registrationUrl).digest('hex').slice(0, 16);
  return `reg-${hash}`;
}

export async function offerSignupFromFacts(
  database: Database,
  input: OfferSignupInput,
  deps: OfferSignupDeps = {},
): Promise<OfferSignupResult> {
  const evidence = input.facts.evidence.trim();
  if (!evidence) {
    await writeAudit(database, input, null, { step: 'offer', reason: 'no_facts' });
    return { ok: false, reason: 'no_facts' };
  }
  const allowed = registrationUrlAllowed(input.facts.registrationUrl);
  if (!allowed.ok) {
    await writeAudit(database, input, null, { step: 'offer', reason: 'url_refused' });
    return { ok: false, reason: 'url_refused' };
  }
  if (input.facts.sessions.length === 0 || input.facts.sessions.length > 12) {
    await writeAudit(database, input, null, { step: 'offer', reason: 'sessions' });
    return { ok: false, reason: 'sessions' };
  }
  const [child] = await database
    .select({
      id: schema.children.id,
      name: schema.children.name,
      dateOfBirth: schema.children.dateOfBirth,
      dobPrecision: schema.children.dobPrecision,
    })
    .from(schema.children)
    .where(and(eq(schema.children.id, input.childId), eq(schema.children.familyId, input.familyId)))
    .limit(1);
  if (!child) {
    await writeAudit(database, input, null, { step: 'offer', reason: 'child_missing' });
    return { ok: false, reason: 'child_missing' };
  }

  const host = new URL(allowed.href).hostname;
  const mode = planModeFor(host, deps.autoHosts);
  if (mode !== 'parent' && registrationPreflightEnabled(input.familyId)) {
    return offerWithTerms(database, input, deps, {
      mode,
      host,
      href: allowed.href,
      child,
    });
  }
  const alreadyOpen =
    registrationPlanRunEnabled() &&
    mode !== 'parent' &&
    input.planOpensAt != null &&
    input.planOpensAt.getTime() <= input.now.getTime();
  const planOpensAt = alreadyOpen
    ? input.now
    : input.planOpensAt &&
        input.planOpensAt.getTime() > input.now.getTime() &&
        registrationPlanRunEnabled() &&
        mode !== 'parent'
      ? input.planOpensAt
      : null;
  const text =
    planOpensAt && mode !== 'parent'
      ? await writePlanOffer(database, input, deps, {
          mode,
          opensAt: planOpensAt,
          childName: input.facts.childFirstName ?? child.name,
          registrationUrl: allowed.href,
        })
      : await writeOffer(input, deps, { childName: child.name, registrationUrl: allowed.href });
  if (!text) {
    await writeAudit(database, input, null, { step: 'offer', reason: 'unwritten' });
    return { ok: false, reason: 'unwritten' };
  }

  const stored = await recordSignupOffer(database, {
    familyId: input.familyId,
    childId: input.childId,
    parentUserId: input.parentUserId,
    activityKey: activityKeyFor(allowed.href),
    activityLabel: input.activityLabel ?? null,
    registrationUrl: allowed.href,
    sessions: [...input.facts.sessions],
    approvedPriceCents: input.facts.approvedPriceCents,
    planOpensAt,
    planAlreadyOpen: alreadyOpen,
    supersede: input.supersede,
    now: input.now,
  });
  if (!stored.ok) {
    await writeAudit(database, input, null, { step: 'offer', reason: stored.reason });
    return { ok: false, reason: stored.reason as OfferSignupReason };
  }
  await writeAudit(database, input, stored.id, {
    step: 'offer',
    source: input.facts.source,
    host,
    sessionCount: input.facts.sessions.length,
    plan: planOpensAt !== null,
  });
  return { ok: true, offerId: stored.id, text, replaced: stored.replaced };
}

/**
 * VIL-715 · the ask with pre-flight on. Hale reads the program first and stops before asking
 * when the child is outside its ages. Otherwise the ask is a plan, its text states the terms,
 * and those terms are stored with the offer so the parent's yes can bind them.
 */
async function offerWithTerms(
  database: Database,
  input: OfferSignupInput,
  deps: OfferSignupDeps,
  known: {
    mode: 'auto' | 'assisted';
    host: string;
    href: string;
    child: { id: string; name: string; dateOfBirth: string; dobPrecision: string };
  },
): Promise<OfferSignupResult> {
  const activityKey = activityKeyFor(known.href);
  // The coach's figures can be the parent's own words. A terms ask states only the page's.
  const pageOnly: OfferSignupInput = {
    ...input,
    facts: {
      ...input.facts,
      sessions: input.facts.sessions.map((session) => ({ ...session, priceCents: null })),
      approvedPriceCents: null,
    },
  };
  const ask = await prepareTermsAsk(
    database,
    {
      familyId: input.familyId,
      child: childFor(known.child),
      parentZone: await parentTimeZone(database, input.parentUserId),
      activityKey,
      registrationUrl: known.href,
      host: known.host,
      sessions: pageOnly.facts.sessions,
      statedOpensAt: input.planOpensAt ?? null,
      now: input.now,
    },
    deps.terms,
  );
  if (ask.kind === 'outside_band') {
    await writeAudit(database, input, null, { step: 'offer', reason: 'age_outside_band' });
    return { ok: false, reason: 'age_outside_band', ageBand: ask.ageBand };
  }
  const text = await writePlanOffer(database, pageOnly, deps, {
    mode: known.mode,
    opensAt: ask.opensAt,
    childName: input.facts.childFirstName ?? known.child.name,
    registrationUrl: known.href,
    terms: ask.writer,
  });
  if (!text) {
    await writeAudit(database, input, null, { step: 'offer', reason: 'unwritten' });
    // No offer exists yet, so the family is the row ops starts from.
    await pageOps(database, {
      site: 'registration_text_unwritten',
      facts: { moment: 'offer' },
      ref: input.familyId,
    });
    return { ok: false, reason: 'unwritten' };
  }
  const stored = await recordSignupOffer(database, {
    familyId: input.familyId,
    childId: input.childId,
    parentUserId: input.parentUserId,
    activityKey,
    activityLabel: input.activityLabel ?? null,
    registrationUrl: known.href,
    sessions: [...pageOnly.facts.sessions],
    approvedPriceCents: null,
    planOpensAt: ask.opensAt,
    planAlreadyOpen: ask.alreadyOpen,
    supersede: input.supersede,
    terms: { shown: ask.shown },
    now: input.now,
  });
  if (!stored.ok) {
    await writeAudit(database, input, null, { step: 'offer', reason: stored.reason });
    return { ok: false, reason: stored.reason as OfferSignupReason };
  }
  await writeAudit(database, input, stored.id, {
    step: 'offer',
    source: input.facts.source,
    host: known.host,
    sessionCount: input.facts.sessions.length,
    plan: true,
    terms: ask.shown.read,
  });
  return { ok: true, offerId: stored.id, text, replaced: stored.replaced };
}

async function writeOffer(
  input: OfferSignupInput,
  deps: OfferSignupDeps,
  known: { childName: string; registrationUrl: string },
): Promise<string | null> {
  const writer = deps.writer ?? defaultWriter();
  const facts: SignupOfferFacts = {
    source: input.facts.source,
    evidence: input.facts.evidence.trim(),
    registrationUrl: known.registrationUrl,
    sessions: input.facts.sessions,
    approvedPriceCents: input.facts.approvedPriceCents,
    childFirstName: input.facts.childFirstName ?? known.childName,
    language: input.facts.language,
  };
  return writer.write(facts);
}

/**
 * VIL-558 · an offer Hale can carry out at the open is offered as a plan: the sessions to
 * rank, a maximum price, the waiver question (auto towns only: on an assisted town the
 * parent ticks it), and the two-places note. The model writes it; code adds the
 * registration link after it.
 */
async function writePlanOffer(
  database: Database,
  input: OfferSignupInput,
  deps: OfferSignupDeps,
  known: {
    mode: 'auto' | 'assisted';
    opensAt: Date;
    childName: string;
    registrationUrl: string;
    terms?: PlanReplyTerms;
  },
): Promise<string | null> {
  const writer = deps.planWriter ?? createPlanReplyWriter(() => resolveReplyClient(undefined));
  const text = await writer.write({
    moment: 'offer',
    mode: known.mode,
    childFirstName: known.childName,
    opensAt: planOpensAtLocal(known.opensAt, await parentTimeZone(database, input.parentUserId)),
    sessions: replySessions(input.facts.sessions),
    maxPriceCents: input.facts.approvedPriceCents,
    waiverAccepted: null,
    question: null,
    refusal: null,
    run: null,
    language:
      input.facts.language ??
      (await readParentLanguage(database, {
        familyId: input.familyId,
        parentUserId: input.parentUserId,
      })),
    ...(known.terms ? { terms: known.terms } : {}),
  });
  return text ? planReplyBody(text, known.registrationUrl) : null;
}

function defaultWriter(): SignupOfferWriter {
  return createSignupOfferWriter(() => resolveReplyClient(undefined));
}

async function writeAudit(
  database: Database,
  input: OfferSignupInput,
  offerId: string | null,
  after: Record<string, unknown>,
): Promise<void> {
  await database.insert(schema.auditLog).values({
    familyId: input.familyId,
    actor: input.parentUserId,
    actionTaken: 'authorized_signup_step',
    targetTable: 'authorized_signup_offers',
    targetId: offerId,
    after: redactSignupAudit(after),
  });
}

/** Sessions the model named, kept only when they already look like store sessions. */
export function sessionsFromModel(raw: readonly SignupSession[]): SignupSession[] | null {
  if (raw.length === 0 || raw.length > 12) return null;
  const out: SignupSession[] = [];
  for (const [index, session] of raw.entries()) {
    const id = KEY.test(session.id) ? session.id : slugSession(session.label, index);
    if (!KEY.test(id) || session.label.trim().length === 0) return null;
    out.push({ ...session, id, label: session.label.trim() });
  }
  return out;
}

function slugSession(label: string, index: number): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug || `session-${index + 1}`;
}
