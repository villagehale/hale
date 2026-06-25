import { type Database, schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { recordEmailSend, unsubscribeUrl } from '~/lib/cron/email-compliance';
import { type WelcomeEmailSender, createWelcomeEmailSender } from './welcome-email';

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
  /** The parent's full name (or null); only the first name is used in the copy. */
  name: string | null;
}

function firstNameOf(name: string | null): string | null {
  const first = name?.trim().split(/\s+/)[0];
  return first ? first : null;
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

  const sendResult = await deps.email.sendWelcome(
    recipient.email,
    firstNameOf(recipient.name),
    unsubUrl,
  );

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
