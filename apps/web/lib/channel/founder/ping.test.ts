import { type Database, schema } from '@hale/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeTransport } from '~/lib/channel/intake/transport';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { defaultFounderPingPorts, offerFounderWelcome } from './ping';

/**
 * The synthetic-probe guard on the founder ping (ads-week audit, 2026-08-28).
 *
 * The operator's live probes text in from the fictional +1 437-555-XXXX range and run
 * the REAL intake end to end — that is what a probe is for. What they must never do is
 * reach a HUMAN: tonight a probe join pinged the founder and masked the real partner's
 * join arriving beside it. The probe keeps its own thread replies; the ping is the
 * human-facing signal, and a family whose channel sits in the probe range never earns
 * one. Named outcome, never a silent drop (rule #11).
 */

const TZ = 'America/Toronto';
const APP_KEY = Buffer.alloc(32, 5).toString('base64');
const FOUNDER_EMAIL = 'founder@villagehale.com';
const FOUNDER_PHONE = '+14165550111';
/** Inside the operator's fictional probe range. */
const PROBE_PHONE = '+14375550142';
/** A real parent's number. */
const REAL_PHONE = '+14165550122';
const NOW = new Date('2026-08-28T14:00:00.000Z');

describe('offerFounderWelcome and synthetic probes', () => {
  let db: TestDb;
  let database: Database;

  beforeEach(async () => {
    db = await createTestDb();
    database = db.database;
    vi.stubEnv('APP_ENCRYPTION_KEY', APP_KEY);
    vi.stubEnv('FOUNDER_ALERT_EMAIL', FOUNDER_EMAIL);
    await seedFamily(FOUNDER_EMAIL, FOUNDER_PHONE, 'Barton');
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await db.close();
  });

  async function seedFamily(
    email: string | null,
    phone: string,
    name: string,
  ): Promise<string> {
    const [user] = await database
      .insert(schema.users)
      .values({ email, name, timezone: TZ })
      .returning({ id: schema.users.id });
    const userId = (user as { id: string }).id;
    const [family] = await database
      .insert(schema.families)
      .values({ displayName: `${name} family`, onboardingStage: 'sms_active' })
      .returning({ id: schema.families.id });
    const familyId = (family as { id: string }).id;
    await database
      .insert(schema.familyMembers)
      .values({ familyId, userId, role: 'primary_parent' });
    await database.insert(schema.parentChannels).values({
      userId,
      familyId,
      kind: 'sms',
      phoneE164Encrypted: encryptString(phone),
      phoneE164Hash: phoneBlindIndex(phone),
      verifiedAt: NOW,
    });
    return familyId;
  }

  it('never pings the founder about a probe-range family, and names the outcome', async () => {
    const probeFamilyId = await seedFamily(null, PROBE_PHONE, 'Probe');
    const transport = new FakeTransport();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const outcome = await offerFounderWelcome(
      database,
      { newFamilyId: probeFamilyId, sourceCode: 'earlyon-georgetown', now: NOW },
      defaultFounderPingPorts(transport),
    );

    expect(outcome).toEqual({ status: 'skipped_synthetic' });
    // Nothing reached a human, and no offer stands for a YES to resolve to.
    expect(transport.sent).toEqual([]);
    expect(warn).toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('still pings for a real number (positive control)', async () => {
    const realFamilyId = await seedFamily(null, REAL_PHONE, 'Ana');
    const transport = new FakeTransport();

    const outcome = await offerFounderWelcome(
      database,
      { newFamilyId: realFamilyId, sourceCode: 'earlyon-georgetown', now: NOW },
      defaultFounderPingPorts(transport),
    );

    expect(outcome).toMatchObject({ status: 'pinged' });
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]?.to).toBe(FOUNDER_PHONE);
  });
});
