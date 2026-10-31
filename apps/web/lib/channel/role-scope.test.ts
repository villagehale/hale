import { describe, expect, it } from 'vitest';
import {
  CAREGIVER_ROLES,
  CONTENT_CLASSES,
  type ContentClass,
  type FamilyRole,
  classifyFamilyEvent,
  isCaregiverRole,
  roleAllows,
  teenChildIds,
} from './role-scope';

const NOW = new Date('2026-07-30T12:00:00.000Z');

/** A 4-year-old and a 14-year-old, so the age gate has something to bite on. */
const TODDLER = { id: 'c-young', name: 'Maya', dateOfBirth: '2022-03-01' };
const TEEN = { id: 'c-teen', name: 'Noor', dateOfBirth: '2012-03-01' };
const CHILDREN = [TODDLER, TEEN];

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

describe('teenChildIds', () => {
  it('reads the teen gate off the DATE OF BIRTH', () => {
    expect([...teenChildIds(CHILDREN, NOW)]).toEqual([TEEN.id]);
  });
});

/**
 * The reminder run holds `family_events` rows, and until VIL-241 · M6 nothing could say
 * who may be told about one.
 */
describe('classifyFamilyEvent — a placed event, for a role', () => {
  const event = (over: Partial<{ childId: string | null; sensitive: boolean }> = {}) => ({
    childId: TODDLER.id,
    sensitive: false,
    ...over,
  });

  it('is event_logistics for a non-teen child, which a caregiver may see', () => {
    expect(classifyFamilyEvent(event(), CHILDREN, NOW)).toBe('event_logistics');
    expect(roleAllows('nanny', 'event_logistics')).toBe(true);
  });

  it('is schedule for a family-wide event', () => {
    expect(classifyFamilyEvent(event({ childId: null }), CHILDREN, NOW)).toBe('schedule');
  });

  it("is teen_content for a 13+ child's event, ahead of every other signal", () => {
    expect(classifyFamilyEvent(event({ childId: TEEN.id }), CHILDREN, NOW)).toBe('teen_content');
    // Teen outranks health, the same order classifyWeekItem uses.
    expect(classifyFamilyEvent(event({ childId: TEEN.id, sensitive: true }), CHILDREN, NOW)).toBe(
      'teen_content',
    );
    for (const role of CAREGIVER_ROLES) expect(roleAllows(role, 'teen_content')).toBe(false);
  });

  it('is health for a sensitive event, which no caregiver may see', () => {
    expect(classifyFamilyEvent(event({ sensitive: true }), CHILDREN, NOW)).toBe('health');
    for (const role of CAREGIVER_ROLES) expect(roleAllows(role, 'health')).toBe(false);
  });

  it('fails closed on a child the caller did not load', () => {
    expect(classifyFamilyEvent(event({ childId: 'c-unknown' }), CHILDREN, NOW)).toBe(
      'teen_content',
    );
  });

  it('ages the child at `now`, so a birthday closes the door on its own', () => {
    const thirteenth = { id: 'c-turning', name: 'Sam', dateOfBirth: '2013-08-01' };
    const before = new Date('2026-07-31T12:00:00.000Z');
    const after = new Date('2026-08-02T12:00:00.000Z');
    expect(classifyFamilyEvent(event({ childId: thirteenth.id }), [thirteenth], before)).toBe(
      'event_logistics',
    );
    expect(classifyFamilyEvent(event({ childId: thirteenth.id }), [thirteenth], after)).toBe(
      'teen_content',
    );
  });
});
