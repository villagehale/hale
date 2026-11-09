import { createHash } from 'node:crypto';
import { type Database, schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { resolveReplyClient } from '~/lib/channel/reply-copy/client';
import { redactSignupAudit } from './audit';
import {
  type SignupOfferFacts,
  type SignupOfferWriter,
  createSignupOfferWriter,
} from './offer-writer';
import { recordSignupOffer } from './store';
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
  | 'not_stored'
  | 'offer_exists'
  | 'activity_key'
  | 'sessions';

export type OfferSignupResult =
  | { ok: true; offerId: string; text: string }
  | { ok: false; reason: OfferSignupReason };

export interface OfferSignupInput {
  familyId: string;
  parentUserId: string;
  childId: string;
  now: Date;
  facts: Omit<SignupOfferFacts, 'childFirstName'> & { childFirstName?: string | null };
}

export interface OfferSignupDeps {
  /** Undefined uses the reply model. Tests inject a writer. */
  writer?: SignupOfferWriter;
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
    })
    .from(schema.children)
    .where(and(eq(schema.children.id, input.childId), eq(schema.children.familyId, input.familyId)))
    .limit(1);
  if (!child) {
    await writeAudit(database, input, null, { step: 'offer', reason: 'child_missing' });
    return { ok: false, reason: 'child_missing' };
  }

  const writer = deps.writer ?? defaultWriter();
  const facts: SignupOfferFacts = {
    source: input.facts.source,
    evidence,
    registrationUrl: allowed.href,
    sessions: input.facts.sessions,
    approvedPriceCents: input.facts.approvedPriceCents,
    childFirstName: input.facts.childFirstName ?? child.name,
    language: input.facts.language,
  };
  const text = await writer.write(facts);
  if (!text) {
    await writeAudit(database, input, null, { step: 'offer', reason: 'unwritten' });
    return { ok: false, reason: 'unwritten' };
  }

  const stored = await recordSignupOffer(database, {
    familyId: input.familyId,
    childId: input.childId,
    parentUserId: input.parentUserId,
    activityKey: activityKeyFor(allowed.href),
    registrationUrl: allowed.href,
    sessions: [...input.facts.sessions],
    approvedPriceCents: input.facts.approvedPriceCents,
    now: input.now,
  });
  if (!stored.ok) {
    await writeAudit(database, input, null, { step: 'offer', reason: stored.reason });
    return { ok: false, reason: stored.reason as OfferSignupReason };
  }
  await writeAudit(database, input, stored.id, {
    step: 'offer',
    source: input.facts.source,
    host: new URL(allowed.href).hostname,
    sessionCount: input.facts.sessions.length,
  });
  return { ok: true, offerId: stored.id, text };
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
