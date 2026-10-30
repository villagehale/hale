import { describe, expect, it, vi } from 'vitest';
import { resolveFamilyFromWebhook } from './resolve-family.js';

const FAMILY_ID = '11111111-1111-4111-8111-111111111111';

// A fake of the narrow db surface resolveFamilyFromWebhook uses: a single
// select(...).from(...).where(...).limit(1) chain resolving to rows. Built by
// hand from the integrations schema (provider + providerMetadata.externalId →
// familyId). No real connection.
function fakeDb(rows: Array<{ familyId: string }>) {
  const limit = vi.fn().mockResolvedValue(rows);
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });
  return { db: { select } as never, where };
}

describe('resolveFamilyFromWebhook', () => {
  it('returns the bound familyId for a known (provider, external_id)', async () => {
    const { db } = fakeDb([{ familyId: FAMILY_ID }]);

    // Stripe carries the connected account id at the top level.
    const familyId = await resolveFamilyFromWebhook(
      'stripe',
      { id: 'evt_1', account: 'acct_known' },
      db,
    );

    expect(familyId).toBe(FAMILY_ID);
  });

  it('returns null when no integration row matches the external id', async () => {
    const { db } = fakeDb([]);

    const familyId = await resolveFamilyFromWebhook(
      'stripe',
      { id: 'evt_1', account: 'acct_unknown' },
      db,
    );

    expect(familyId).toBeNull();
  });

  it('returns null without querying when the external id is absent from the payload', async () => {
    const { db } = fakeDb([{ familyId: FAMILY_ID }]);
    const select = (db as unknown as { select: ReturnType<typeof vi.fn> }).select;

    const familyId = await resolveFamilyFromWebhook('stripe', { id: 'evt_1' }, db);

    expect(familyId).toBeNull();
    expect(select).not.toHaveBeenCalled();
  });

  it('returns null without throwing on a malformed (non-object) payload', async () => {
    const { db } = fakeDb([{ familyId: FAMILY_ID }]);

    await expect(resolveFamilyFromWebhook('stripe', null, db)).resolves.toBeNull();
    await expect(resolveFamilyFromWebhook('twilio', 'not-json', db)).resolves.toBeNull();
    await expect(resolveFamilyFromWebhook('gmail', 42, db)).resolves.toBeNull();
  });

  it('returns null for a provider with no extractor configured', async () => {
    const { db } = fakeDb([{ familyId: FAMILY_ID }]);

    const familyId = await resolveFamilyFromWebhook(
      'unknown_provider',
      { id: 'x' },
      db,
    );

    expect(familyId).toBeNull();
  });
});
