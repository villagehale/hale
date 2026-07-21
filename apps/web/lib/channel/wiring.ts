import { type Database, schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { hasOptedOut, recordEmailSend } from '~/lib/cron/email-compliance';
import { loadLoopPrefsView } from '~/lib/loop/prefs';
import { smsConsentLive } from './consent';
import type { DispatchPorts } from './dispatch';
import { countRecentSends, dedupeActive, recordChannelMessage } from './ledger';
import type { Channel, ChannelKind, TemplateRenderer } from './types';

/**
 * Builds the prod DispatchPorts from a db handle + the injected channels/renderer.
 * The dispatch stays a pure decision engine; this is the only place it touches the
 * real db, the CASL email seam (hasOptedOut/recordEmailSend), the loop prefs, the
 * SMS-consent read, and push-token existence — so policy lives in exactly one place.
 */
export function buildDispatchPorts(
  database: Database,
  opts: {
    channels: Partial<Record<ChannelKind, Channel>>;
    renderer: TemplateRenderer;
    now?: () => Date;
  },
): DispatchPorts {
  const now = opts.now ?? (() => new Date());
  return {
    now,
    loadPrefs: (userId) => loadLoopPrefsView(userId, database),
    loadParent: async (userId) => {
      const rows = await database
        .select({ email: schema.users.email, timezone: schema.users.timezone })
        .from(schema.users)
        .where(eq(schema.users.id, userId))
        .limit(1);
      const row = rows[0];
      return { email: row?.email ?? null, timezone: row?.timezone ?? 'America/Toronto' };
    },
    emailOptedOut: (userId, emailType) =>
      hasOptedOut(database, userId, emailType as Parameters<typeof hasOptedOut>[2]),
    smsConsentLive: (userId) => smsConsentLive(userId, database, now()),
    hasLivePushToken: async (userId) => {
      const rows = await database
        .select({ id: schema.pushTokens.id })
        .from(schema.pushTokens)
        .where(eq(schema.pushTokens.userId, userId))
        .limit(1);
      return rows.length > 0;
    },
    countRecent: (userId, category, since) => countRecentSends(userId, category, since, database),
    activeDedupe: (dedupeKey) => dedupeActive(dedupeKey, database),
    record: (write) => recordChannelMessage(write, database),
    recordEmailSend: (input) =>
      recordEmailSend(database, {
        userId: input.userId,
        familyId: input.familyId,
        emailType: input.emailType as Parameters<typeof recordEmailSend>[1]['emailType'],
        recipient: input.recipient,
        providerMessageId: input.providerMessageId,
      }),
    audit: async (r) => {
      await database.insert(schema.auditLog).values(r);
    },
    channels: opts.channels,
    renderer: opts.renderer,
  };
}
