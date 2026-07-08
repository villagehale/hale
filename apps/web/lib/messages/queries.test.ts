import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEEN_REDACTED_PLACEHOLDER } from '~/lib/dashboard/mappers';

/**
 * loadMessages end-to-end over a fake db — the mobile Messages inbox loader. Covers
 * the two things that must be right structurally: rule #1 teen redaction (a teen
 * action's raw type never reaches the feed, including the double-miss family
 * fallback), and the reverse-chron merge of digest + action rows. The db chokepoint
 * (~/lib/db) is mocked; the loader owns the redaction so the route can stay thin.
 */

const FAMILY_ID = '11111111-1111-4111-8111-111111111111';
const TEEN_DOB = '2011-01-01'; // ~15y → teenager
const TODDLER_DOB = '2024-05-01'; // ~2y → toddler

vi.mock('~/lib/family', () => ({ currentFamilyId: async () => FAMILY_ID }));

interface DigestRow {
  id: string;
  breakdown: { briefText?: string } | null;
  generatedAt: Date;
}
interface ActionRow {
  id: string;
  actionType: string;
  state: string;
  draftedAt: Date;
  executedAt: Date | null;
  revertedAt: Date | null;
  revertedReason: string | null;
  teenContent: boolean;
  childDob: string | null;
}

let childrenDob: Array<{ dateOfBirth: string }> = [];
let digestRows: DigestRow[] = [];
let actionRows: ActionRow[] = [];

/** Fake db routed by projection keys, mirroring the approvals double-miss fake. */
function fakeDb() {
  const select = vi.fn().mockImplementation((proj: Record<string, unknown>) => {
    const keys = Object.keys(proj ?? {});
    // familyHasTeenager: select({ dateOfBirth }) from children.
    if (keys.length === 1 && keys[0] === 'dateOfBirth') {
      return { from: () => ({ where: async () => childrenDob }) };
    }
    // readFamilyTimezone: select({ timezone }) — empty → DEFAULT_TIMEZONE (Toronto).
    if (keys.length === 1 && keys[0] === 'timezone') {
      return {
        from: () => ({ innerJoin: () => ({ where: () => ({ limit: async () => [] }) }) }),
      };
    }
    // daily_digests read: select includes `breakdown`.
    if (keys.includes('breakdown')) {
      const node = () =>
        Object.assign(Promise.resolve(digestRows), {
          limit: () => Promise.resolve(digestRows),
          orderBy: () => node(),
        });
      return { from: () => ({ where: () => node() }) };
    }
    // actions join: select includes `actionType`.
    const node = () =>
      Object.assign(Promise.resolve(actionRows), {
        limit: () => Promise.resolve(actionRows),
        orderBy: () => node(),
      });
    return {
      from: () => ({ innerJoin: () => ({ leftJoin: () => ({ where: () => node() }) }) }),
    };
  });
  return { select } as never;
}

vi.mock('~/lib/db', () => ({ db: () => fakeDb() }));

const { loadMessages } = await import('./queries');

describe('loadMessages', () => {
  beforeEach(() => {
    process.env.DATABASE_URL = 'postgres://test';
    childrenDob = [{ dateOfBirth: TODDLER_DOB }];
    digestRows = [];
    actionRows = [];
  });
  afterEach(() => {
    process.env.DATABASE_URL = undefined;
  });

  it('returns an empty feed with no DATABASE_URL (preview) — no db touched', async () => {
    process.env.DATABASE_URL = undefined;
    expect(await loadMessages()).toEqual([]);
  });

  it('maps a drafted action to its parent-facing framing tagged for Approvals navigation', async () => {
    actionRows = [
      {
        id: 'a1',
        actionType: 'reply_to_email',
        state: 'drafted_for_approval',
        draftedAt: new Date('2026-06-20T10:00:00Z'),
        executedAt: null,
        revertedAt: null,
        revertedReason: null,
        teenContent: false,
        childDob: null,
      },
    ];
    const [msg] = await loadMessages();
    expect(msg?.kind).toBe('action');
    expect(msg?.actionState).toBe('drafted_for_approval');
    expect(msg?.body).toBe('Hale drafted "Reply to email" for your yes.');
  });

  it('surfaces the digest brief prose wholesale, skipping digest rows with no briefText', async () => {
    digestRows = [
      { id: 'd1', breakdown: { briefText: 'A calm day.' }, generatedAt: new Date('2026-06-20T13:00:00Z') },
      { id: 'd2', breakdown: {}, generatedAt: new Date('2026-06-19T13:00:00Z') },
    ];
    const msgs = await loadMessages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.kind).toBe('digest');
    expect(msgs[0]?.body).toBe('A calm day.');
  });

  it('merges digests + actions newest-first by their true instant, not the display string', async () => {
    digestRows = [
      { id: 'd1', breakdown: { briefText: 'Brief.' }, generatedAt: new Date('2026-06-20T09:00:00Z') },
    ];
    actionRows = [
      {
        id: 'a1',
        actionType: 'create_calendar_event',
        state: 'autonomous',
        draftedAt: new Date('2026-05-01T09:00:00Z'),
        executedAt: new Date('2026-06-21T09:00:00Z'),
        revertedAt: null,
        revertedReason: null,
        teenContent: false,
        childDob: null,
      },
      {
        id: 'a2',
        actionType: 'place_supply_order',
        state: 'needs_human',
        draftedAt: new Date('2026-06-18T09:00:00Z'),
        executedAt: null,
        revertedAt: null,
        revertedReason: null,
        teenContent: false,
        childDob: null,
      },
    ];
    const msgs = await loadMessages();
    // a1 executed Jun 21 (newest), digest Jun 20, a2 drafted Jun 18 (oldest).
    expect(msgs.map((m) => m.id)).toEqual(['action-a1', 'digest-d1', 'action-a2']);
  });

  it('redacts a teen action end-to-end — the raw action type never reaches the feed (rule #1)', async () => {
    actionRows = [
      {
        id: 'a1',
        actionType: 'reply_to_email',
        state: 'drafted_for_approval',
        draftedAt: new Date('2026-06-20T10:00:00Z'),
        executedAt: null,
        revertedAt: null,
        revertedReason: null,
        teenContent: false,
        childDob: TEEN_DOB,
      },
    ];
    const [msg] = await loadMessages();
    expect(msg?.teenRedacted).toBe(true);
    expect(msg?.body).toBe(TEEN_REDACTED_PLACEHOLDER);
    expect(JSON.stringify(msg)).not.toContain('Reply to email');
    // The lifecycle frame still survives so the row still routes to Approvals.
    expect(msg?.actionState).toBe('drafted_for_approval');
  });

  it('redacts an unattributed action via the family-has-teen fallback (double-miss, rule #1)', async () => {
    childrenDob = [{ dateOfBirth: TEEN_DOB }, { dateOfBirth: TODDLER_DOB }];
    actionRows = [
      {
        id: 'a1',
        actionType: 'reply_to_email',
        state: 'drafted_for_approval',
        draftedAt: new Date('2026-06-20T10:00:00Z'),
        executedAt: null,
        revertedAt: null,
        revertedReason: null,
        teenContent: false,
        childDob: null,
      },
    ];
    const [msg] = await loadMessages();
    expect(msg?.teenRedacted).toBe(true);
    expect(JSON.stringify(msg)).not.toContain('Reply to email');
  });

  it('frames a declined draft honestly and stamps it by reverted_at, not drafted_at (never a false rollback)', async () => {
    actionRows = [
      {
        id: 'a1',
        actionType: 'reply_to_email',
        state: 'reverted',
        draftedAt: new Date('2026-06-10T09:00:00Z'),
        executedAt: null,
        revertedAt: new Date('2026-06-22T09:00:00Z'),
        revertedReason: 'declined_by_human',
        teenContent: false,
        childDob: null,
      },
    ];
    digestRows = [
      { id: 'd1', breakdown: { briefText: 'Brief.' }, generatedAt: new Date('2026-06-15T09:00:00Z') },
    ];
    const msgs = await loadMessages();
    // Declined Jun 22 sorts above the Jun 15 digest — by when it settled, not the
    // Jun 10 draft; and the copy says declined, never "rolled back" (it never ran).
    expect(msgs.map((m) => m.id)).toEqual(['action-a1', 'digest-d1']);
    expect(msgs[0]?.body).toBe('You declined "Reply to email".');
  });
});
