import type { Database } from '@hale/db';
import { describe, expect, it } from 'vitest';
import { foldPassportIntoOutbound } from './fold';
import { attachPassportToEmailAlert, syncPassportFromCalendarChanges } from './ingest';

const database = new Proxy({} as Database, {
  get() {
    throw new Error('database touched while the passport flag is off');
  },
});

describe('passport flag off', () => {
  it('does not read the database from email, calendar, or an outbound fold', async () => {
    const email = await attachPassportToEmailAlert(database, {
      body: 'Practice moved to Tuesday.',
      sending: true,
      familyId: 'family',
      parentUserId: 'parent',
      integrationId: 'integration',
      messageId: 'message',
      subject: 'Registration confirmed: Soccer, 12 weeks',
      title: 'Soccer',
      kind: 'booking_confirmation',
      teenAttributed: false,
      childRef: null,
      now: new Date('2026-04-15T15:00:00Z'),
    });
    expect(email.body).toBe('Practice moved to Tuesday.');
    await email.afterSend();

    await syncPassportFromCalendarChanges(database, {
      familyId: 'family',
      integrationId: 'integration',
      parentUserId: 'parent',
      changes: [{ recurringEventId: 'series', title: 'Soccer', status: 'confirmed' }],
      now: new Date('2026-04-15T15:00:00Z'),
    });

    const folded = await foldPassportIntoOutbound({
      database,
      familyId: 'family',
      parentUserId: 'parent',
      inboundBody: 'yes',
      outboundBody: 'See you Tuesday.',
      now: new Date('2026-04-15T15:00:00Z'),
      client: null,
    });
    expect(folded).toBe('See you Tuesday.');
  });
});
