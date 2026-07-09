import { type Database, schema } from '@hale/db';
import { deriveStage } from '@hale/types';
import { and, eq } from 'drizzle-orm';
import { recordEmailSend, unsubscribeUrl } from '~/lib/cron/email-compliance';
import {
  type WelcomeContent,
  type WelcomeEmailSender,
  createWelcomeEmailSender,
  firstNameToken,
  placePhrase,
  stagePhrase,
} from './welcome-email';

/**
 * The idempotent welcome send, run once when a family completes onboarding. It is
 * transactional (sent regardless of DIGEST_SEND_ENABLED), but still carries the
 * CASL footer + a working unsubscribe like every Hale email.
 *
 * Idempotency lives in the send ledger: a 'welcome' row in email_sends means the
 * email already left Hale, so a second onboarding/login is a no-op. The row is
 * written only on an ACCEPTED send, so a provider rejection leaves nothing and a
 * later attempt can retry. The send is keyed to the user (not the family) so it
 * is one welcome per parent.
 *
 * The greeting and copy read from persisted rows, not the caller's session: the
 * name falls back to users.name (the session token may carry none on mobile), and
 * the family copy is derived from the family's coarse area and the children's
 * stages (rule #1 — never a child name or DOB).
 */

const WELCOME_EMAIL_TYPE = 'welcome' as const;

export type SendWelcomeResult =
  | { status: 'sent' }
  | { status: 'already_sent' }
  | { status: 'send_failed' }
  /** No unsubscribe secret is configured, so a CASL-required link cannot be
   * minted — we don't send a footer with a broken link. */
  | { status: 'skipped'; reason: 'no_unsub_secret' };

export interface WelcomeDeps {
  email: WelcomeEmailSender;
}

export function defaultWelcomeDeps(): WelcomeDeps {
  return { email: createWelcomeEmailSender() };
}

export interface WelcomeRecipient {
  userId: string;
  familyId: string;
  email: string;
  /** The parent's name from the session, if any. Falls back to users.name — the
   * session token can carry no name on the mobile Bearer bridge. */
  name: string | null;
}

/** True when a welcome email has already been recorded as sent to this user. */
async function alreadyWelcomed(database: Database, userId: string): Promise<boolean> {
  const rows = await database
    .select({ id: schema.emailSends.id })
    .from(schema.emailSends)
    .where(
      and(
        eq(schema.emailSends.userId, userId),
        eq(schema.emailSends.emailType, WELCOME_EMAIL_TYPE),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/** Build the personalized, non-PII welcome content from persisted rows. The name
 * prefers the session name and falls back to users.name; the place + stage phrases
 * are derived coarsely (rule #1 — no child name, no DOB). */
async function buildContent(
  database: Database,
  recipient: WelcomeRecipient,
): Promise<WelcomeContent> {
  let name = recipient.name;
  if (!name) {
    const [userRow] = await database
      .select({ name: schema.users.name })
      .from(schema.users)
      .where(eq(schema.users.id, recipient.userId))
      .limit(1);
    name = userRow?.name ?? null;
  }

  const [familyRow] = await database
    .select({ areaCoarse: schema.families.areaCoarse, city: schema.families.city })
    .from(schema.families)
    .where(eq(schema.families.id, recipient.familyId))
    .limit(1);

  const childRows = await database
    .select({ dateOfBirth: schema.children.dateOfBirth })
    .from(schema.children)
    .where(eq(schema.children.familyId, recipient.familyId));

  const stages = childRows.map((child) => deriveStage(child.dateOfBirth));

  return {
    firstName: firstNameToken(name),
    place: placePhrase(familyRow?.areaCoarse ?? null, familyRow?.city ?? null),
    stage: stagePhrase(stages),
  };
}

export async function sendWelcomeEmail(
  database: Database,
  recipient: WelcomeRecipient,
  deps: WelcomeDeps = defaultWelcomeDeps(),
): Promise<SendWelcomeResult> {
  if (await alreadyWelcomed(database, recipient.userId)) {
    return { status: 'already_sent' };
  }

  const unsubUrl = unsubscribeUrl({ userId: recipient.userId, emailType: WELCOME_EMAIL_TYPE });
  if (!unsubUrl) {
    return { status: 'skipped', reason: 'no_unsub_secret' };
  }

  const content = await buildContent(database, recipient);
  const sendResult = await deps.email.sendWelcome(recipient.email, content, unsubUrl);

  if (!sendResult.accepted) {
    return { status: 'send_failed' };
  }

  await recordEmailSend(database, {
    userId: recipient.userId,
    familyId: recipient.familyId,
    emailType: WELCOME_EMAIL_TYPE,
    recipient: recipient.email,
    providerMessageId: sendResult.providerMessageId,
  });

  return { status: 'sent' };
}
