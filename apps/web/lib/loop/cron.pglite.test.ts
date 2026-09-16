import { schema } from '@hale/db';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// cron.ts statically imports ./gather for its default dep, whose query modules
// transitively pull next-auth; stub the auth edge so this Node test resolves.
vi.mock('~/auth', () => ({ auth: vi.fn() }));

import { CANARY_PHONE_E164 } from '~/lib/channel/canary/config';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { createTestDb, seedFamily, type TestDb } from '~/lib/testing/pglite';
import { selectFamiliesToCompose } from './cron';

/**
 * WHO the week-plan sweep spends on, over the real roster tables.
 *
 * This is the one per-family cron that reaches a paid model: `composeWeekVoice`
 * and the placement reviewer are both real Anthropic calls. The four proactive
 * SENDERS gate on onboarding stage 'sms_active', which a probe household never
 * reaches — this one gates on nothing at all, so the probe seeded for the
 * inbound canary would be composed for once a week, forever.
 */

let db: TestDb;

// Saturday, 08:00 America/Toronto: the compose slot for a parent on the shipped
// defaults (weekStartDay 0 → send Sunday, compose the day before, at 08:00).
const COMPOSE_MOMENT = new Date('2026-07-25T12:00:00Z');

beforeAll(async () => {
  process.env.APP_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
  db = await createTestDb();
  // The full migration chain past Vitest's 30s hook default, the way every
  // other PGlite suite here boots: a whole-repo run has hundreds of files in
  // flight and this hook is what times out first (see deep-answer-at-question-
  // time.test.ts).
}, 120_000);

afterAll(async () => {
  await db.close();
});

describe('selectFamiliesToCompose', () => {
  it('composes for a real family and never for the synthetic probe household', async () => {
    const real = await seedFamily(db.database, 'Real Family');
    const probe = await seedFamily(db.database, 'Hale inbound canary');
    await db.database.insert(schema.parentChannels).values({
      userId: probe.parentUserId,
      familyId: probe.familyId,
      kind: 'sms',
      phoneE164Encrypted: encryptString(CANARY_PHONE_E164),
      phoneE164Hash: phoneBlindIndex(CANARY_PHONE_E164),
      verifiedAt: new Date(),
    });

    const selected = await selectFamiliesToCompose(db.database, COMPOSE_MOMENT);

    // The positive control carries the test: an empty result would mean the
    // moment is wrong, not that the probe was excluded.
    expect(selected).toContain(real.familyId);
    expect(selected).not.toContain(probe.familyId);
  });
});
