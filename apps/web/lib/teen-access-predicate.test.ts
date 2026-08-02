import { describe, expect, it } from 'vitest';
import {
  MAX_GRANT_WINDOW_MS,
  SAFETY_ESCALATION_WINDOW_MS,
  type TeenGrantState,
  boundGrantWindow,
  isTeenGrantActive,
  redactsTeenContent,
  teenAccessUnlocksFrom,
} from './teen-access';

/**
 * VIL-147 · the ONE predicate every teen unlock consults. It is deliberately PURE:
 * the SQL that fetches candidate grants only NARROWS, and this function re-decides
 * every condition in code, so a mistake in a WHERE clause can never widen access.
 *
 * Expected values are derived from rule #1 / rule #5 and the privacy-page promise —
 * explicit, logged, time-limited, teen-assented, revocable — not from what the
 * implementation happens to return.
 */

const NOW = new Date('2026-08-02T12:00:00.000Z');
const CHILD = 'c1';
const FAMILY = 'fam-1';
const PARENT = 'parent-1';
const VIEWER = { familyId: FAMILY, parentUserId: PARENT };

/** An otherwise-perfect ACTIVE grant; each test breaks exactly one condition. */
function activeGrant(overrides: Partial<TeenGrantState> = {}): TeenGrantState {
  return {
    familyId: FAMILY,
    grantedToUserId: PARENT,
    childId: CHILD,
    scope: 'message_content',
    teenAssentAt: new Date('2026-08-02T09:00:00.000Z'),
    teenNotifiedAt: new Date('2026-08-02T09:00:00.000Z'),
    startsAt: new Date('2026-08-02T09:00:00.000Z'),
    expiresAt: new Date('2026-08-03T09:00:00.000Z'),
    revokedAt: null,
    safetyEscalation: false,
    ...overrides,
  };
}

/** Local wrapper: the cases below vary the GRANT, so the viewer is constant. The
 * tenancy axes get their own dedicated cases at the end of this block. */
function isTeenGrantActive_(grant: TeenGrantState, now: Date): boolean {
  return isTeenGrantActive(grant, VIEWER, now);
}

describe('isTeenGrantActive', () => {
  it('accepts a grant that is assented, started, unexpired and unrevoked', () => {
    expect(isTeenGrantActive_(activeGrant(), NOW)).toBe(true);
  });

  it('rejects a grant with no teen assent (rule #5) unless it is a safety escalation', () => {
    expect(isTeenGrantActive_(activeGrant({ teenAssentAt: null }), NOW)).toBe(false);
    expect(
      isTeenGrantActive_(activeGrant({ teenAssentAt: null, safetyEscalation: true }), NOW),
    ).toBe(true);
  });

  it('rejects a merely-requested grant — no activation window at all', () => {
    expect(isTeenGrantActive_(activeGrant({ startsAt: null, expiresAt: null }), NOW)).toBe(false);
  });

  it('rejects a half-set window rather than reading it as open-ended', () => {
    expect(isTeenGrantActive_(activeGrant({ expiresAt: null }), NOW)).toBe(false);
    expect(isTeenGrantActive_(activeGrant({ startsAt: null }), NOW)).toBe(false);
  });

  it('rejects a grant whose window has not opened yet', () => {
    const future = new Date(NOW.getTime() + 60_000);
    expect(
      isTeenGrantActive_(
        activeGrant({ startsAt: future, expiresAt: new Date(future.getTime() + 3_600_000) }),
        NOW,
      ),
    ).toBe(false);
  });

  it('rejects an EXPIRED grant — content redacts again the instant the window closes', () => {
    expect(isTeenGrantActive_(activeGrant({ expiresAt: NOW }), NOW)).toBe(false);
    expect(isTeenGrantActive_(activeGrant({ expiresAt: new Date(NOW.getTime() - 1) }), NOW)).toBe(
      false,
    );
    // Still active one millisecond before the boundary.
    expect(isTeenGrantActive_(activeGrant({ expiresAt: new Date(NOW.getTime() + 1) }), NOW)).toBe(
      true,
    );
  });

  it('rejects a REVOKED grant even while its window is still open', () => {
    expect(isTeenGrantActive_(activeGrant({ revokedAt: NOW }), NOW)).toBe(false);
    expect(
      isTeenGrantActive_(activeGrant({ revokedAt: new Date(NOW.getTime() - 60_000) }), NOW),
    ).toBe(false);
  });

  it('rejects a window longer than the hard maximum, however it was written', () => {
    const startsAt = new Date('2026-08-02T09:00:00.000Z');
    const tooLong = new Date(startsAt.getTime() + MAX_GRANT_WINDOW_MS + 1);
    expect(isTeenGrantActive_(activeGrant({ startsAt, expiresAt: tooLong }), NOW)).toBe(false);
  });

  it('rejects a grant whose teen was never actually notified (rule #1 makes notice a condition)', () => {
    expect(isTeenGrantActive_(activeGrant({ teenNotifiedAt: null }), NOW)).toBe(false);
    // Not even the safety exception, which rule #1 permits only "where the teen is
    // notified" — an undelivered notice is exactly the case that must stay shut.
    expect(
      isTeenGrantActive_(
        activeGrant({ teenNotifiedAt: null, teenAssentAt: null, safetyEscalation: true }),
        NOW,
      ),
    ).toBe(false);
  });

  it('rejects another family’s grant even if every other field is perfect', () => {
    // The confused-deputy axis. The SQL also filters this, but the predicate must
    // re-check it — otherwise one dropped WHERE clause leaks family into family.
    expect(isTeenGrantActive(activeGrant({ familyId: 'other-family' }), VIEWER, NOW)).toBe(false);
  });

  it('rejects a grant issued to a DIFFERENT parent', () => {
    expect(isTeenGrantActive(activeGrant({ grantedToUserId: 'other-parent' }), VIEWER, NOW)).toBe(
      false,
    );
  });

  it('holds a safety escalation to the SHORTER window', () => {
    const startsAt = new Date('2026-08-02T09:00:00.000Z');
    // A span that is fine for an assented grant but too long for an escalation.
    const span = new Date(startsAt.getTime() + SAFETY_ESCALATION_WINDOW_MS + 1);
    expect(isTeenGrantActive_(activeGrant({ startsAt, expiresAt: span }), NOW)).toBe(true);
    expect(
      isTeenGrantActive_(
        activeGrant({ startsAt, expiresAt: span, teenAssentAt: null, safetyEscalation: true }),
        NOW,
      ),
    ).toBe(false);
  });
});

describe('boundGrantWindow', () => {
  it('caps a normal grant at 7 days and an escalation at 24 hours', () => {
    expect(MAX_GRANT_WINDOW_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(SAFETY_ESCALATION_WINDOW_MS).toBe(24 * 60 * 60 * 1000);

    expect(boundGrantWindow(NOW, false).expiresAt).toEqual(
      new Date(NOW.getTime() + MAX_GRANT_WINDOW_MS),
    );
    expect(boundGrantWindow(NOW, true).expiresAt).toEqual(
      new Date(NOW.getTime() + SAFETY_ESCALATION_WINDOW_MS),
    );
    expect(boundGrantWindow(NOW, false).startsAt).toEqual(NOW);
  });
});

describe('redactsTeenContent — the seam every parent-facing read calls', () => {
  const unlocks = teenAccessUnlocksFrom([activeGrant()], VIEWER, NOW);

  it('never redacts a row that does not concern a teen', () => {
    expect(redactsTeenContent(false, CHILD, 'message_content', unlocks)).toBe(false);
  });

  it('redacts a teen row by default — with NO grants, behaviour is unchanged', () => {
    expect(redactsTeenContent(true, CHILD, 'message_content')).toBe(true);
    expect(redactsTeenContent(true, CHILD, 'calendar_detail')).toBe(true);
    expect(redactsTeenContent(true, null, 'message_content')).toBe(true);
  });

  it('unlocks ONLY the granted child and the granted scope', () => {
    expect(redactsTeenContent(true, CHILD, 'message_content', unlocks)).toBe(false);
    // A different scope on the same child stays redacted (scope boundary).
    expect(redactsTeenContent(true, CHILD, 'calendar_detail', unlocks)).toBe(true);
    expect(redactsTeenContent(true, CHILD, 'child_profile', unlocks)).toBe(true);
    // A different child is never covered by this child's grant.
    expect(redactsTeenContent(true, 'other-child', 'message_content', unlocks)).toBe(true);
  });

  it('a calendar-scope grant never reveals message content', () => {
    const calendarOnly = teenAccessUnlocksFrom(
      [activeGrant({ scope: 'calendar_detail' })],
      VIEWER,
      NOW,
    );
    expect(redactsTeenContent(true, CHILD, 'calendar_detail', calendarOnly)).toBe(false);
    expect(redactsTeenContent(true, CHILD, 'message_content', calendarOnly)).toBe(true);
  });

  it('keeps an UNATTRIBUTED teen row redacted even under a grant', () => {
    // A row Hale could not tie to a specific child cannot be proven to be the
    // granted teen's, so a grant must never unlock it (fail closed).
    expect(redactsTeenContent(true, null, 'message_content', unlocks)).toBe(true);
  });

  it('ignores inactive grants when building the unlock set', () => {
    const stale = teenAccessUnlocksFrom(
      [
        activeGrant({ revokedAt: NOW }),
        activeGrant({ scope: 'calendar_detail', expiresAt: new Date(NOW.getTime() - 1) }),
        activeGrant({ scope: 'child_profile', teenAssentAt: null }),
      ],
      VIEWER,
      NOW,
    );
    expect(redactsTeenContent(true, CHILD, 'message_content', stale)).toBe(true);
    expect(redactsTeenContent(true, CHILD, 'calendar_detail', stale)).toBe(true);
    expect(redactsTeenContent(true, CHILD, 'child_profile', stale)).toBe(true);
  });
});
