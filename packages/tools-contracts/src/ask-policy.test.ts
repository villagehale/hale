import type { ActionType } from '@hale/types';
import { describe, expect, it } from 'vitest';
import {
  ACTION_CLASSES,
  ACTION_CLASSES_BY_KIND,
  ASK_TIERS,
  ASK_TIER_BY_CLASS,
  type AskFacts,
  type AskTier,
  CROSS_PARENT_ACTION_TYPES,
  REQUIRED_CHECKS,
  actionClassesFor,
  askTierFor,
  isAskPolicyKind,
  strictestAskTier,
} from './index.js';

/**
 * VIL-719. Expectations are written out by hand from the ticket (money, registering a kid,
 * contacting a third party and another person's information ask first; calendar changes tell
 * after; reading and remembering just happen), never copied from the table under test.
 */

/** Hand-mirrored from @hale/types ActionType. */
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
  'calendar_add',
  'calendar_move',
  'calendar_cancel',
] as const satisfies readonly ActionType[];

const EXPECTED_TIER: Record<ActionType, AskTier> = {
  send_email: 'ask_first',
  reply_to_email: 'ask_first',
  create_calendar_event: 'ask_first',
  update_calendar_event: 'ask_first',
  place_supply_order: 'ask_first',
  cancel_supply_order: 'ask_first',
  fill_pdf_form: 'ask_first',
  submit_government_form: 'ask_first',
  book_clinic_portal: 'ask_first',
  cancel_clinic_appointment: 'ask_first',
  share_photos_with_family: 'ask_first',
  add_to_digest_only: 'just_do',
  add_to_routine: 'just_do',
  calendar_add: 'tell_after',
  calendar_move: 'tell_after',
  calendar_cancel: 'tell_after',
};

const FACT_SETS: readonly AskFacts[] = [
  {},
  { commitsFamily: true },
  { commitsFamily: false },
  { writesAnotherParentsCalendar: true },
  { writesAnotherParentsCalendar: false },
];

const rank = (tier: AskTier): number => ASK_TIERS.indexOf(tier);

describe('the three tiers', () => {
  it('are ordered from least to most asking', () => {
    expect(ASK_TIERS).toEqual(['just_do', 'tell_after', 'ask_first']);
  });

  it('give every class exactly the tier the ticket names', () => {
    expect(ASK_TIER_BY_CLASS).toEqual({
      read: 'just_do',
      remember: 'just_do',
      family_calendar: 'tell_after',
      parent_draft: 'tell_after',
      spend_money: 'ask_first',
      register_or_book: 'ask_first',
      contact_third_party: 'ask_first',
      other_persons_info: 'ask_first',
    });
    expect(Object.keys(ASK_TIER_BY_CLASS).sort()).toEqual([...ACTION_CLASSES].sort());
  });

  it('take the strictest tier, and none is just do', () => {
    expect(strictestAskTier([])).toBe('just_do');
    expect(strictestAskTier(['just_do', 'tell_after'])).toBe('tell_after');
    expect(strictestAskTier(['tell_after', 'ask_first', 'just_do'])).toBe('ask_first');
  });
});

describe('every action kind', () => {
  it('is classified, and nothing else is', () => {
    expect(Object.keys(ACTION_CLASSES_BY_KIND).sort()).toEqual([...ALL_ACTION_TYPES].sort());
    for (const kind of ALL_ACTION_TYPES) {
      expect(isAskPolicyKind(kind)).toBe(true);
      expect(ACTION_CLASSES_BY_KIND[kind].length).toBeGreaterThan(0);
    }
  });

  it.each(ALL_ACTION_TYPES)('%s has the tier the ticket gives it', (kind) => {
    expect(askTierFor(kind)).toBe(EXPECTED_TIER[kind]);
  });

  it('lists each class once, in the policy order', () => {
    for (const kind of ALL_ACTION_TYPES) {
      const classes = actionClassesFor(kind);
      expect(new Set(classes).size).toBe(classes.length);
      expect(classes).toEqual(ACTION_CLASSES.filter((c) => classes.includes(c)));
    }
  });

  it('a calendar write that also touches the co-parent asks first (strictest wins)', () => {
    expect(actionClassesFor('create_calendar_event')).toEqual([
      'family_calendar',
      'other_persons_info',
    ]);
    expect(askTierFor('create_calendar_event')).toBe('ask_first');
  });
});

describe('facts', () => {
  it.each(ALL_ACTION_TYPES)('never lower the tier of %s', (kind) => {
    const base = rank(askTierFor(kind));
    for (const facts of FACT_SETS) {
      expect(rank(askTierFor(kind, facts))).toBeGreaterThanOrEqual(base);
      for (const actionClass of actionClassesFor(kind)) {
        expect(actionClassesFor(kind, facts)).toContain(actionClass);
      }
    }
  });

  it.each(ALL_ACTION_TYPES)('a commitment reading makes %s ask first', (kind) => {
    expect(actionClassesFor(kind, { commitsFamily: true })).toContain('register_or_book');
    expect(askTierFor(kind, { commitsFamily: true })).toBe('ask_first');
  });

  it('a false fact adds nothing', () => {
    expect(askTierFor('calendar_add', { commitsFamily: false })).toBe('tell_after');
    expect(askTierFor('add_to_digest_only', { commitsFamily: false })).toBe('just_do');
    expect(askTierFor('calendar_add', { writesAnotherParentsCalendar: false })).toBe('tell_after');
  });

  it.each(['calendar_add', 'calendar_move', 'calendar_cancel'] as const)(
    "a write that would land on another parent's own calendar makes %s ask first",
    (kind) => {
      const facts = { writesAnotherParentsCalendar: true };
      expect(actionClassesFor(kind, facts)).toEqual(['family_calendar', 'other_persons_info']);
      expect(askTierFor(kind, facts)).toBe('ask_first');
    },
  );
});

describe('fail closed', () => {
  it('a kind the table does not know asks first and has no class', () => {
    const unknown = 'wire_money' as ActionType;
    expect(isAskPolicyKind(unknown)).toBe(false);
    expect(actionClassesFor(unknown)).toEqual([]);
    expect(askTierFor(unknown)).toBe('ask_first');
  });

  it('an inherited object key is not a kind', () => {
    expect(isAskPolicyKind('toString')).toBe(false);
    expect(askTierFor('toString' as ActionType)).toBe('ask_first');
  });
});

describe('agrees with the other per-kind tables', () => {
  it('a kind spends money exactly when the reviewer must check the spending cap (rule #7)', () => {
    for (const kind of ALL_ACTION_TYPES) {
      const checksCap = (REQUIRED_CHECKS[kind] as readonly string[]).includes('check_spending_cap');
      expect(actionClassesFor(kind).includes('spend_money')).toBe(checksCap);
    }
  });

  it('a kind with a recipient allowlist contacts a third party', () => {
    for (const kind of ALL_ACTION_TYPES) {
      if ((REQUIRED_CHECKS[kind] as readonly string[]).includes('check_recipient_allowlist')) {
        expect(actionClassesFor(kind)).toContain('contact_third_party');
      }
    }
  });

  it("a cross-parent kind touches another person's information (rule #5)", () => {
    for (const kind of CROSS_PARENT_ACTION_TYPES) {
      expect(actionClassesFor(kind)).toContain('other_persons_info');
      expect(askTierFor(kind)).toBe('ask_first');
    }
  });
});
