import type { WeekPlanItem } from '@hale/db';
import { describe, expect, it } from 'vitest';
import {
  CAREGIVER_ROLES,
  CONTENT_CLASSES,
  type ContentClass,
  type FamilyRole,
  classifyWeekItem,
  isCaregiverRole,
  roleAllows,
  scopeWeekItemsForRole,
  teenChildIds,
} from './role-scope';

const NOW = new Date('2026-07-30T12:00:00.000Z');

/** A 4-year-old and a 14-year-old, so the age gate has something to bite on. */
const TODDLER = { id: 'c-young', name: 'Maya', dateOfBirth: '2022-03-01' };
const TEEN = { id: 'c-teen', name: 'Noor', dateOfBirth: '2012-03-01' };
const CHILDREN = [TODDLER, TEEN];

function item(overrides: Partial<WeekPlanItem> = {}): WeekPlanItem {
  return {
    kind: 'village',
    title: 'Swim lesson',
    childIds: [TODDLER.id],
    startsAt: '2026-08-03',
    endsAt: null,
    location: '150 Main St',
    sourceRef: null,
    needs: 'none',
    privacySensitive: false,
    ...overrides,
  };
}

/**
 * The matrix as the ticket specifies it, restated INDEPENDENTLY of the module so the
 * test fails if the shipped table drifts. Caregivers receive the schedule, pickup
 * duty, and the logistics of things they are on — and nothing else, ever.
 */
const CAREGIVER_ALLOWED: ContentClass[] = ['schedule', 'pickup_duty', 'event_logistics'];
const CAREGIVER_DENIED: ContentClass[] = [
  'health',
  'teen_content',
  'village_suggestion',
  'registration',
  'family_settings',
];

describe('role-scope · the matrix', () => {
  it('covers every content class exactly once between allowed and denied', () => {
    expect([...CAREGIVER_ALLOWED, ...CAREGIVER_DENIED].sort()).toEqual([...CONTENT_CLASSES].sort());
  });

  it.each(CAREGIVER_ROLES)('%s receives only the three caregiver classes', (role) => {
    for (const cls of CAREGIVER_ALLOWED) {
      expect(roleAllows(role, cls)).toBe(true);
    }
    for (const cls of CAREGIVER_DENIED) {
      expect(roleAllows(role, cls)).toBe(false);
    }
  });

  it.each(['primary_parent', 'co_parent'] as FamilyRole[])(
    '%s gets the full surface — every content class',
    (role) => {
      for (const cls of CONTENT_CLASSES) {
        expect(roleAllows(role, cls)).toBe(true);
      }
    },
  );

  it.each(['extended', 'service'] as FamilyRole[])(
    'legacy bucket %s carries no scope at all',
    (role) => {
      for (const cls of CONTENT_CLASSES) {
        expect(roleAllows(role, cls)).toBe(false);
      }
    },
  );

  it('names exactly the three scoped caregiver roles', () => {
    expect([...CAREGIVER_ROLES].sort()).toEqual(['babysitter', 'grandparent', 'nanny']);
    expect(isCaregiverRole('nanny')).toBe(true);
    expect(isCaregiverRole('co_parent')).toBe(false);
    expect(isCaregiverRole('primary_parent')).toBe(false);
  });
});

describe('role-scope · classifying a week item', () => {
  it('reads the teen gate off the DATE OF BIRTH, not a flag on the item', () => {
    expect([...teenChildIds(CHILDREN, NOW)]).toEqual([TEEN.id]);
    // The item claims to be an ordinary, non-sensitive village outing. It concerns a
    // 13+ child, so it is teen content regardless of what the item says about itself.
    expect(classifyWeekItem(item({ childIds: [TEEN.id] }), teenChildIds(CHILDREN, NOW))).toBe(
      'teen_content',
    );
  });

  it('treats teen involvement as decisive even on a mixed-child item', () => {
    const mixed = item({ childIds: [TODDLER.id, TEEN.id] });
    expect(classifyWeekItem(mixed, teenChildIds(CHILDREN, NOW))).toBe('teen_content');
  });

  it('maps appointments and anything privacy-sensitive to health', () => {
    expect(classifyWeekItem(item({ kind: 'appointment' }), new Set())).toBe('health');
    expect(classifyWeekItem(item({ privacySensitive: true }), new Set())).toBe('health');
  });

  it('maps the one ranked pick to village_suggestion and everything else to schedule', () => {
    expect(classifyWeekItem(item({ kind: 'suggestion' }), new Set())).toBe('village_suggestion');
    expect(classifyWeekItem(item({ kind: 'routine' }), new Set())).toBe('schedule');
    expect(classifyWeekItem(item({ kind: 'birthday' }), new Set())).toBe('schedule');
    expect(classifyWeekItem(item({ kind: 'village' }), new Set())).toBe('schedule');
  });
});

describe('role-scope · scoping a week for a role', () => {
  const week: WeekPlanItem[] = [
    item({ kind: 'village', title: 'Swim lesson' }),
    item({ kind: 'routine', title: 'Tuesday daycare pickup', childIds: [] }),
    item({ kind: 'appointment', title: 'Maya — 4-year checkup', privacySensitive: true }),
    item({ kind: 'suggestion', title: 'Try the new nature centre', needs: 'decision' }),
    item({ kind: 'village', title: 'Robotics club', childIds: [TEEN.id] }),
  ];

  it.each(CAREGIVER_ROLES)('%s sees only the schedule items', (role) => {
    const titles = scopeWeekItemsForRole({
      role,
      items: week,
      children: CHILDREN,
      now: NOW,
    }).map((i) => i.title);
    expect(titles).toEqual(['Swim lesson', 'Tuesday daycare pickup']);
  });

  it.each(CAREGIVER_ROLES)('%s never receives a health item', (role) => {
    const scoped = scopeWeekItemsForRole({ role, items: week, children: CHILDREN, now: NOW });
    expect(scoped.some((i) => i.privacySensitive || i.kind === 'appointment')).toBe(false);
  });

  it.each(CAREGIVER_ROLES)("%s never receives a 13+ child's item", (role) => {
    const scoped = scopeWeekItemsForRole({ role, items: week, children: CHILDREN, now: NOW });
    expect(scoped.some((i) => i.childIds.includes(TEEN.id))).toBe(false);
  });

  it('keeps the whole week for a co-parent, including the teen item', () => {
    const scoped = scopeWeekItemsForRole({
      role: 'co_parent',
      items: week,
      children: CHILDREN,
      now: NOW,
    });
    expect(scoped).toEqual(week);
  });

  it('drops a teen item for a caregiver even when the child list is stale-looking', () => {
    // A child the artifact references but the caller did not load. Unknown ⇒ we cannot
    // prove they are under 13, so the item must not be sent (fail closed).
    const orphan = item({ childIds: ['c-unknown'], title: 'Mystery outing' });
    const scoped = scopeWeekItemsForRole({
      role: 'grandparent',
      items: [orphan],
      children: CHILDREN,
      now: NOW,
    });
    expect(scoped).toEqual([]);
  });

  it('lets a family-wide item (no children) through to a caregiver', () => {
    const familyWide = item({ childIds: [], title: 'Block party' });
    const scoped = scopeWeekItemsForRole({
      role: 'babysitter',
      items: [familyWide],
      children: CHILDREN,
      now: NOW,
    });
    expect(scoped).toEqual([familyWide]);
  });
});
