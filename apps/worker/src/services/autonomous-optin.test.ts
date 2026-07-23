import { schema } from '@hale/db';
import { describe, expect, it, vi } from 'vitest';
import { hasAutonomousActionOptIn } from './memory-writer.js';

const FAMILY_ID = '11111111-1111-4111-8111-111111111111';
const PRIMARY_ID = '22222222-2222-4222-8222-222222222222';

interface ConsentRow {
  granted: boolean;
  revokedAt: Date | null;
  grantedAt: Date;
}

/**
 * Fakes the two reads the opt-in check runs:
 *   select(family_members).where().limit(1)          → the primary parent user id
 *   select(consent_records).where().orderBy().limit(1) → the LATEST consent row for
 *     (primary parent, autonomous_action_class, scope=actionType), applying the real
 *     `desc(grantedAt)` ordering to the seeded rows so a test can prove latest-wins.
 */
function fakeDb(opts: { primaryUserId: string | null; consentRows: ConsentRow[] }) {
  const select = vi.fn(() => ({
    from: (table: unknown) => ({
      where: () => {
        if (table === schema.familyMembers) {
          return {
            limit: async () => (opts.primaryUserId ? [{ userId: opts.primaryUserId }] : []),
          };
        }
        // consent_records: honour desc(grantedAt) + limit so latest-row-wins is real.
        return {
          orderBy: () => ({
            limit: async (n: number) =>
              [...opts.consentRows]
                .sort((a, b) => b.grantedAt.getTime() - a.grantedAt.getTime())
                .slice(0, n),
          }),
        };
      },
    }),
  }));
  return { select } as never;
}

const t = (iso: string) => new Date(iso);

describe('hasAutonomousActionOptIn — primary-parent per-action-type autonomy opt-in', () => {
  it('false when the family has no primary parent (cannot be opted in)', async () => {
    const db = fakeDb({ primaryUserId: null, consentRows: [] });
    expect(await hasAutonomousActionOptIn(FAMILY_ID, 'send_email', db)).toBe(false);
  });

  it('false when there is no consent row for the scope at all (default: not opted in)', async () => {
    const db = fakeDb({ primaryUserId: PRIMARY_ID, consentRows: [] });
    expect(await hasAutonomousActionOptIn(FAMILY_ID, 'send_email', db)).toBe(false);
  });

  it('true when the latest row is granted and not revoked', async () => {
    const db = fakeDb({
      primaryUserId: PRIMARY_ID,
      consentRows: [{ granted: true, revokedAt: null, grantedAt: t('2026-07-01T00:00:00Z') }],
    });
    expect(await hasAutonomousActionOptIn(FAMILY_ID, 'send_email', db)).toBe(true);
  });

  it('false after an APPEND-ONLY withdrawal — a newer granted=false row wins over the grant', async () => {
    const db = fakeDb({
      primaryUserId: PRIMARY_ID,
      consentRows: [
        { granted: true, revokedAt: null, grantedAt: t('2026-07-01T00:00:00Z') },
        { granted: false, revokedAt: null, grantedAt: t('2026-07-10T00:00:00Z') },
      ],
    });
    expect(await hasAutonomousActionOptIn(FAMILY_ID, 'send_email', db)).toBe(false);
  });

  it('false after a REVOKED-AT withdrawal — the latest row carries a revokedAt', async () => {
    const db = fakeDb({
      primaryUserId: PRIMARY_ID,
      consentRows: [
        { granted: true, revokedAt: t('2026-07-10T00:00:00Z'), grantedAt: t('2026-07-01T00:00:00Z') },
      ],
    });
    expect(await hasAutonomousActionOptIn(FAMILY_ID, 'send_email', db)).toBe(false);
  });

  it('true again after a re-grant following a withdrawal (latest row is a fresh grant)', async () => {
    const db = fakeDb({
      primaryUserId: PRIMARY_ID,
      consentRows: [
        { granted: true, revokedAt: null, grantedAt: t('2026-07-01T00:00:00Z') },
        { granted: false, revokedAt: null, grantedAt: t('2026-07-10T00:00:00Z') },
        { granted: true, revokedAt: null, grantedAt: t('2026-07-20T00:00:00Z') },
      ],
    });
    expect(await hasAutonomousActionOptIn(FAMILY_ID, 'send_email', db)).toBe(true);
  });
});
