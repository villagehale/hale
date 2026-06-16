import { describe, expect, it } from 'vitest';
import type { ActionType } from '@hale/types';
import {
  CROSS_PARENT_ACTION_TYPES,
  REQUIRED_CHECKS,
  REVIEWER_TOOLS,
  coverageSatisfiedWithResults,
  isCrossParentActionType,
} from './index.js';

/**
 * Expectations are hand-derived from the Zod schemas in index.ts and the
 * Hale hard rules (CLAUDE.md #3 + #7) — never copied from runtime output.
 */

/** Action types that move money — must be gated by check_spending_cap (hard rule #7). */
const MONETARY_ACTION_TYPES = [
  'place_supply_order',
  'cancel_supply_order',
  'book_clinic_portal',
  'submit_government_form',
] as const satisfies readonly ActionType[];

/** The full canonical action-type list, hand-mirrored from @hale/types ActionType. */
const ALL_ACTION_TYPES = [
  'send_email',
  'reply_to_email',
  'create_calendar_event',
  'update_calendar_event',
  'place_supply_order',
  'cancel_supply_order',
  'fill_pdf_form',
  'submit_government_form',
  'book_clinic_portal',
  'cancel_clinic_appointment',
  'share_photos_with_family',
  'add_to_digest_only',
  'add_to_routine',
] as const satisfies readonly ActionType[];

describe('REQUIRED_CHECKS policy matrix', () => {
  it('covers every canonical action type with a key', () => {
    const keys = Object.keys(REQUIRED_CHECKS).sort();
    expect(keys).toEqual([...ALL_ACTION_TYPES].sort());
  });

  it('gives every action type a non-empty list of required checks', () => {
    for (const actionType of ALL_ACTION_TYPES) {
      expect(REQUIRED_CHECKS[actionType].length).toBeGreaterThan(0);
    }
  });

  it('only names checks that exist in REVIEWER_TOOLS', () => {
    const known = new Set(Object.keys(REVIEWER_TOOLS));
    for (const actionType of ALL_ACTION_TYPES) {
      for (const check of REQUIRED_CHECKS[actionType]) {
        expect(known.has(check)).toBe(true);
      }
    }
  });

  it('never requires the permanently not_configured stub checks', () => {
    for (const actionType of ALL_ACTION_TYPES) {
      const checks = REQUIRED_CHECKS[actionType] as readonly string[];
      expect(checks).not.toContain('check_calendar_conflict');
      expect(checks).not.toContain('check_vaccine_schedule');
    }
  });

  it('gates every monetary action type with check_spending_cap (hard rule #7)', () => {
    for (const actionType of MONETARY_ACTION_TYPES) {
      expect(REQUIRED_CHECKS[actionType]).toContain('check_spending_cap');
    }
  });

  it('requires PII + recipient + sender allowlist checks on reply_to_email', () => {
    const checks = REQUIRED_CHECKS.reply_to_email;
    expect(checks).toContain('check_pii_leak');
    expect(checks).toContain('check_recipient_allowlist');
    expect(checks).toContain('check_sender_allowlist');
  });

  it('lists no duplicate checks within any entry', () => {
    for (const actionType of ALL_ACTION_TYPES) {
      const checks = REQUIRED_CHECKS[actionType];
      expect(new Set(checks).size).toBe(checks.length);
    }
  });
});

describe('CROSS_PARENT_ACTION_TYPES — hard rule #5 membership', () => {
  // Hand-derived from the ActionType union by effect: only types that touch BOTH
  // parents' data (a child's outward photo share + shared-calendar writes).
  const EXPECTED_CROSS_PARENT = [
    'share_photos_with_family',
    'create_calendar_event',
    'update_calendar_event',
  ] as const satisfies readonly ActionType[];

  it('contains exactly the three cross-parent action types', () => {
    expect([...CROSS_PARENT_ACTION_TYPES].sort()).toEqual([...EXPECTED_CROSS_PARENT].sort());
  });

  it('isCrossParentActionType is true for each cross-parent type', () => {
    for (const actionType of EXPECTED_CROSS_PARENT) {
      expect(isCrossParentActionType(actionType)).toBe(true);
    }
  });

  it('isCrossParentActionType is false for single-parent-surface types', () => {
    for (const actionType of ALL_ACTION_TYPES) {
      if ((EXPECTED_CROSS_PARENT as readonly string[]).includes(actionType)) continue;
      expect(isCrossParentActionType(actionType)).toBe(false);
    }
  });
});

describe('coverageSatisfiedWithResults — extra cases beyond coverage-results.test.ts', () => {
  const allOk = (actionType: (typeof ALL_ACTION_TYPES)[number]) =>
    REQUIRED_CHECKS[actionType].map((tool) => ({ tool, ok: true }));

  it('still passes when extra non-required tools were also invoked', () => {
    expect(
      coverageSatisfiedWithResults('reply_to_email', [
        ...allOk('reply_to_email'),
        { tool: 'check_action_time_window', ok: true },
      ]),
    ).toBe(true);
  });

  it('is order-independent (results may arrive in any order)', () => {
    expect(coverageSatisfiedWithResults('reply_to_email', [...allOk('reply_to_email')].reverse())).toBe(
      true,
    );
  });
});
