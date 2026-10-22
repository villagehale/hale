import { type Database, schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { captureServerEvent } from '~/lib/analytics/server-capture';
import { loadSmsChannelState } from '~/lib/channels/sms-consent-core';
import { loadLoopPrefsView } from '~/lib/loop/prefs';
import type { DispatchPorts } from './dispatch';
import { dedupeActive, recordChannelMessage } from './ledger';
import { threadIfParent } from './thread';
import type { Channel, ChannelKind, TemplateRenderer } from './types';

/**
 * Builds the prod DispatchPorts from a db handle + the injected channels/renderer.
 * The dispatch stays a pure decision engine; this is the only place it touches the
 * real db, the loop prefs, and the SMS-consent read — so policy lives in exactly one place.
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
        .select({ timezone: schema.users.timezone })
        .from(schema.users)
        .where(eq(schema.users.id, userId))
        .limit(1);
      const row = rows[0];
      return { timezone: row?.timezone ?? 'America/Toronto' };
    },
    // The live SMS-consent gate is VIL-212's source of truth: an active, verified,
    // non-revoked parent_channels row (consent_records is its append-only CASL
    // ledger, not the live state).
    smsConsentLive: async (userId) => (await loadSmsChannelState(database, userId)).enrolled,
    activeDedupe: (dedupeKey) => dedupeActive(dedupeKey, database),
    record: (write) => recordChannelMessage(write, database),
    capture: captureServerEvent,
    audit: async (r) => {
      await database.insert(schema.auditLog).values(r);
    },
    // The loop is the one pipe that can address someone who is not a parent of the
    // family (a caregiver seat), so the thread write goes through the guarded writer —
    // see thread.ts `threadIfParent`.
    threadMessage: async (input) => {
      await threadIfParent(database, input);
    },
    channels: opts.channels,
    renderer: opts.renderer,
  };
}
