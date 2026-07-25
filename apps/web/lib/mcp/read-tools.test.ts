import type { schema } from '@hale/db';
import { describe, expect, it, vi } from 'vitest';

vi.mock('~/lib/dashboard/trail-query', () => ({ readFamilyTimezone: vi.fn() }));
vi.mock('~/lib/loop/assistant-events', () => ({ readTeenSafeFamilyEventsInWindow: vi.fn() }));
vi.mock('~/lib/loop/queries', () => ({ readWeekPlan: vi.fn() }));
vi.mock('~/lib/village/queries', () => ({ readVillage: vi.fn() }));

import { toMcpVillagePicks, toMcpWeekPlan } from './read-tools';

const NOW = new Date('2026-07-20T12:00:00.000Z');
// Emma is 4 at NOW; Liam turned 13 on 2026-07-01 (a non-teen when a plan composed in
// June was written, a teen when read now — the age-drift case).
const EMMA = { id: 'emma-id', name: 'Emma', dateOfBirth: '2022-01-01', gender: 'girl' };
const LIAM = { id: 'liam-id', name: 'Liam', dateOfBirth: '2013-07-01', gender: 'boy' };

function planWith(items: schema.WeekPlan['items']): schema.WeekPlan {
  return {
    id: 'plan-id',
    familyId: 'family-id',
    weekStart: '2026-07-20',
    composedAt: new Date('2026-06-28T12:00:00.000Z'),
    summary: 'A steady week.',
    voice: null,
    status: 'composed',
    items,
  } satisfies schema.WeekPlan;
}

describe('MCP read projections', () => {
  it('drops internal child/provenance ids and the raw teen-baked title', () => {
    const plan = planWith([
      {
        kind: 'appointment',
        title: 'a private appointment for your teen',
        childIds: ['liam-id'],
        startsAt: null,
        endsAt: null,
        location: null,
        sourceRef: { table: 'children', id: 'liam-id' },
        needs: 'calendar_add',
        privacySensitive: true,
      },
    ]);
    const result = toMcpWeekPlan(plan, [LIAM], 'generic', new Set(), NOW);
    expect(JSON.stringify(result)).not.toContain('liam-id');
    expect(JSON.stringify(result)).not.toContain('children');
    expect(result.items[0]?.privacySensitive).toBe(true);
  });

  it('never sends a non-teen child first name or health detail to the third-party model (default posture)', () => {
    // The artifact bakes "Emma — flu shot"; child_name_level defaults to 'generic',
    // so the parent's own email says "your kid — a checkup". MCP must match, not leak.
    const plan = planWith([
      {
        kind: 'appointment',
        title: 'Emma — flu shot',
        childIds: ['emma-id'],
        startsAt: '2026-07-22',
        endsAt: null,
        location: "Dr. Lee's office",
        sourceRef: { table: 'children', id: 'emma-id' },
        needs: 'calendar_add',
        privacySensitive: true,
      },
    ]);
    const title = toMcpWeekPlan(plan, [EMMA], 'generic', new Set(), NOW).items[0]?.title ?? '';
    expect(title).toBe('a checkup');
    expect(title).not.toContain('Emma');
    expect(title).not.toContain('flu');
    expect(toMcpWeekPlan(plan, [EMMA], 'generic', new Set(), NOW).items[0]?.location).toBeNull();
  });

  it('strips a now-teen child name baked before their 13th birthday (live age-drift, rule #1)', () => {
    const plan = planWith([
      {
        kind: 'birthday',
        title: "Liam's birthday",
        childIds: ['liam-id'],
        startsAt: '2026-07-23',
        endsAt: null,
        location: 'home',
        sourceRef: { table: 'children', id: 'liam-id' },
        needs: 'none',
        privacySensitive: false,
      },
    ]);
    const item = toMcpWeekPlan(plan, [LIAM], 'first_name', new Set(), NOW).items[0];
    expect(item?.title).not.toContain('Liam');
    expect(item?.location).toBeNull();
  });

  it('coarsens a sensitive-flagged non-teen family event that the composer left raw', () => {
    const plan = planWith([
      {
        kind: 'birthday',
        title: 'Dr. Lee — therapy',
        childIds: ['emma-id'],
        startsAt: '2026-07-24',
        endsAt: null,
        location: 'clinic',
        sourceRef: { table: 'family_events', id: 'fe-1' },
        needs: 'none',
        privacySensitive: false,
      },
    ]);
    const item = toMcpWeekPlan(plan, [EMMA], 'generic', new Set(['fe-1']), NOW).items[0];
    expect(item?.title).toBe('an appointment');
    expect(item?.title).not.toContain('therapy');
    expect(item?.location).toBeNull();
    expect(item?.privacySensitive).toBe(true);
  });

  it('honors a first_name dial for a non-teen, non-sensitive item (no over-redaction)', () => {
    const plan = planWith([
      {
        kind: 'birthday',
        title: "Emma's birthday",
        childIds: ['emma-id'],
        startsAt: '2026-07-25',
        endsAt: null,
        location: null,
        sourceRef: { table: 'children', id: 'emma-id' },
        needs: 'none',
        privacySensitive: false,
      },
    ]);
    const title = toMcpWeekPlan(plan, [EMMA], 'first_name', new Set(), NOW).items[0]?.title ?? '';
    expect(title).toContain('Emma');
  });

  it('bounds Village output and omits mutation URLs, coordinates, and source plumbing', () => {
    const candidate = {
      id: 'pick-1',
      childId: null,
      title: 'Library storytime',
      kind: 'activity',
      cadence: 'ongoing',
      eventDate: null,
      seasons: null,
      discoveredAt: '2026-07-20T00:00:00.000Z',
      summary: 'A weekly public storytime.',
      coverageNote: 'East end',
      sourceUrl: 'https://library.example/storytime',
      acceptHref: '/private/accept',
      endorseHref: '/private/endorse',
      saveHref: '/private/save',
      shareHref: '/private/share',
      endorsementCount: 4,
      endorsedByFamily: true,
      saved: false,
      accepted: false,
      lat: 43.1,
      lng: -79.1,
      venueName: 'Library',
      rating: 4.8,
      ratingCount: 12,
      priceLevel: 'free',
      ageRange: '2–5',
      indoorOutdoor: 'indoor',
      teenAttributed: false,
    };

    const result = toMcpVillagePicks([candidate, { ...candidate, id: 'pick-2' }], 1);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      id: 'pick-1',
      title: 'Library storytime',
      kind: 'activity',
      summary: 'A weekly public storytime.',
      cadence: 'ongoing',
      eventDate: null,
      venueName: 'Library',
      sourceUrl: 'https://library.example/storytime',
      teenAttributed: false,
    });
    expect(JSON.stringify(result)).not.toContain('accept');
    expect(JSON.stringify(result)).not.toContain('43.1');
  });
});
