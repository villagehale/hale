import type { schema } from '@hale/db';
import { describe, expect, it, vi } from 'vitest';

vi.mock('~/lib/dashboard/trail-query', () => ({ readFamilyTimezone: vi.fn() }));
vi.mock('~/lib/loop/assistant-events', () => ({ readTeenSafeFamilyEventsInWindow: vi.fn() }));
vi.mock('~/lib/loop/queries', () => ({ readWeekPlan: vi.fn() }));
vi.mock('~/lib/village/queries', () => ({ readVillage: vi.fn() }));

import { toMcpVillagePicks, toMcpWeekPlan } from './read-tools';

const PLAN = {
  id: 'plan-id',
  familyId: 'family-id',
  weekStart: '2026-07-20',
  composedAt: new Date('2026-07-19T12:00:00.000Z'),
  summary: 'A steady week.',
  voice: null,
  status: 'composed',
  items: [
    {
      kind: 'appointment',
      title: 'a private appointment for your teen',
      childIds: ['private-child-id'],
      startsAt: null,
      endsAt: null,
      location: null,
      sourceRef: { table: 'private_table', id: 'private-row-id' },
      needs: 'calendar_add',
      privacySensitive: true,
    },
  ],
} satisfies schema.WeekPlan;

describe('MCP read projections', () => {
  it('returns the persisted teen-safe week plan without internal child/provenance ids', () => {
    const result = toMcpWeekPlan(PLAN);
    expect(result).toEqual({
      weekStart: '2026-07-20',
      summary: 'A steady week.',
      status: 'composed',
      items: [
        {
          kind: 'appointment',
          title: 'a private appointment for your teen',
          startsAt: null,
          endsAt: null,
          location: null,
          needs: 'calendar_add',
          privacySensitive: true,
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain('private-child-id');
    expect(JSON.stringify(result)).not.toContain('private_table');
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
