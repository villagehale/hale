import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@hale/db';
import { referralCode } from './code';
import { resolveReferrerFamilyId } from './attribution';

const KEY = Buffer.alloc(32, 3).toString('base64');
const REFERRER = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const BYSTANDER = '9c858901-8a57-4791-81fe-4c455b099bc9';

/** Just enough drizzle to answer `select({id}).from(families)`. */
function databaseWith(ids: readonly string[]) {
  const select = vi.fn(() => ({ from: async () => ids.map((id) => ({ id })) }));
  return { database: { select } as unknown as Database, select };
}

describe('resolveReferrerFamilyId', () => {
  const prev = process.env.APP_ENCRYPTION_KEY;
  beforeEach(() => {
    process.env.APP_ENCRYPTION_KEY = KEY;
  });
  afterEach(() => {
    process.env.APP_ENCRYPTION_KEY = prev;
  });

  it('resolves a forwarded tag back to the family that forwarded it', async () => {
    const { database } = databaseWith([BYSTANDER, REFERRER]);

    await expect(resolveReferrerFamilyId(database, referralCode(REFERRER))).resolves.toBe(REFERRER);
  });

  it('resolves case-insensitively — a link can be retyped in caps', async () => {
    const { database } = databaseWith([REFERRER]);

    await expect(
      resolveReferrerFamilyId(database, referralCode(REFERRER).toUpperCase()),
    ).resolves.toBe(REFERRER);
  });

  it('returns null for a tag matching no family (a link outlives the family that made it)', async () => {
    const { database } = databaseWith([BYSTANDER]);

    await expect(resolveReferrerFamilyId(database, referralCode(REFERRER))).resolves.toBeNull();
  });

  it('never touches the database for a QR venue tag or an untagged arrival', async () => {
    const { database, select } = databaseWith([REFERRER]);

    await expect(resolveReferrerFamilyId(database, 'earlyon-richmondhill')).resolves.toBeNull();
    await expect(resolveReferrerFamilyId(database, null)).resolves.toBeNull();
    expect(select).not.toHaveBeenCalled();
    // Positive control: the same reader DOES query when the tag is a referral, so the
    // assertion above is measuring a skipped scan rather than a broken fake.
    await resolveReferrerFamilyId(database, referralCode(REFERRER));
    expect(select).toHaveBeenCalledTimes(1);
  });
});
