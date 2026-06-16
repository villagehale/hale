import { describe, expect, it } from 'vitest';
import type { ActionType } from './action.js';
import {
  PLAN_ENTITLEMENTS,
  type Entitlement,
  type PlanTier,
  entitlementRequiredFor,
  hasEntitlement,
} from './entitlements.js';

/**
 * Expectations are hand-derived from the ratified pricing (state.md, 2026-06-12)
 * and the ActionType union — never copied from runtime output.
 *   free   — observe/draft only.
 *   plus   — L3 autonomy.
 *   family — L3 + commerce + portal automation.
 */

const ALL_TIERS = ['free', 'plus', 'family'] as const satisfies readonly PlanTier[];
const ALL_ENTITLEMENTS = [
  'autonomy_l3',
  'commerce',
  'portal_automation',
] as const satisfies readonly Entitlement[];

/** Full canonical action-type list, hand-mirrored from @hale/types ActionType. */
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

describe('PLAN_ENTITLEMENTS map', () => {
  it('covers exactly the three canonical tiers', () => {
    expect(Object.keys(PLAN_ENTITLEMENTS).sort()).toEqual([...ALL_TIERS].sort());
  });

  it('grants free nothing, plus L3 only, family everything (hand-derived)', () => {
    expect(PLAN_ENTITLEMENTS.free).toEqual([]);
    expect(PLAN_ENTITLEMENTS.plus).toEqual(['autonomy_l3']);
    expect([...PLAN_ENTITLEMENTS.family].sort()).toEqual([...ALL_ENTITLEMENTS].sort());
  });

  it('only names known entitlements', () => {
    const known = new Set(ALL_ENTITLEMENTS);
    for (const tier of ALL_TIERS) {
      for (const ent of PLAN_ENTITLEMENTS[tier]) {
        expect(known.has(ent)).toBe(true);
      }
    }
  });

  it('lists no duplicate entitlements within any tier', () => {
    for (const tier of ALL_TIERS) {
      const ents = PLAN_ENTITLEMENTS[tier];
      expect(new Set(ents).size).toBe(ents.length);
    }
  });
});

describe('hasEntitlement', () => {
  it('free has no entitlements', () => {
    for (const ent of ALL_ENTITLEMENTS) {
      expect(hasEntitlement('free', ent)).toBe(false);
    }
  });

  it('plus has only autonomy_l3', () => {
    expect(hasEntitlement('plus', 'autonomy_l3')).toBe(true);
    expect(hasEntitlement('plus', 'commerce')).toBe(false);
    expect(hasEntitlement('plus', 'portal_automation')).toBe(false);
  });

  it('family has all three', () => {
    for (const ent of ALL_ENTITLEMENTS) {
      expect(hasEntitlement('family', ent)).toBe(true);
    }
  });
});

describe('entitlementRequiredFor', () => {
  it('maps every canonical action type (exhaustiveness)', () => {
    for (const actionType of ALL_ACTION_TYPES) {
      const result = entitlementRequiredFor(actionType);
      expect(result === null || ALL_ENTITLEMENTS.includes(result)).toBe(true);
    }
  });

  it('classifies supply-order actions as commerce', () => {
    expect(entitlementRequiredFor('place_supply_order')).toBe('commerce');
    expect(entitlementRequiredFor('cancel_supply_order')).toBe('commerce');
  });

  it('classifies clinic-portal actions as portal_automation', () => {
    expect(entitlementRequiredFor('book_clinic_portal')).toBe('portal_automation');
    expect(entitlementRequiredFor('cancel_clinic_appointment')).toBe('portal_automation');
  });

  it('requires no extra entitlement for email/calendar/form/photo/digest actions', () => {
    const baseL3Only = [
      'send_email',
      'reply_to_email',
      'create_calendar_event',
      'update_calendar_event',
      'fill_pdf_form',
      'submit_government_form',
      'share_photos_with_family',
      'add_to_digest_only',
      'add_to_routine',
    ] as const satisfies readonly ActionType[];
    for (const actionType of baseL3Only) {
      expect(entitlementRequiredFor(actionType)).toBeNull();
    }
  });
});

describe('tier × action gating (the orchestrator invariant)', () => {
  /** Mirrors the orchestrator gate: autonomous execution allowed iff L3 + any required extra. */
  function autonomousAllowed(tier: PlanTier, actionType: ActionType): boolean {
    if (!hasEntitlement(tier, 'autonomy_l3')) return false;
    const required = entitlementRequiredFor(actionType);
    return required === null || hasEntitlement(tier, required);
  }

  it('free can never act autonomously, even for base actions', () => {
    expect(autonomousAllowed('free', 'send_email')).toBe(false);
    expect(autonomousAllowed('free', 'place_supply_order')).toBe(false);
  });

  it('plus acts autonomously for base actions but not commerce/portal', () => {
    expect(autonomousAllowed('plus', 'send_email')).toBe(true);
    expect(autonomousAllowed('plus', 'place_supply_order')).toBe(false);
    expect(autonomousAllowed('plus', 'book_clinic_portal')).toBe(false);
  });

  it('family acts autonomously across every action type', () => {
    for (const actionType of ALL_ACTION_TYPES) {
      expect(autonomousAllowed('family', actionType)).toBe(true);
    }
  });
});
