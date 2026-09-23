import type { ProgramDomain, RegistrationWindow } from '@hale/db';
import { describe, expect, it } from 'vitest';
import { decideRadar } from '~/lib/channel/intake/radar-decide';
import { renderRadarDeterministically } from '~/lib/channel/intake/radar-voice';
import { matchRegistrationWindows } from './match-registration-windows';

/**
 * VIL-360. Toronto opens a cycle on two mornings. A North York family (M2N) must
 * hear the North York morning from the same reply path every other town uses
 * (`decideRadar` → `renderRadarDeterministically`), and an Etobicoke or downtown
 * family must still hear theirs. The dates are synthetic — Winter 2027 is not
 * published — so this does not seed a row the discovery list is still watching.
 */

const NOW = new Date('2026-11-20T15:00:00.000Z');
const SOURCE = 'https://www.toronto.ca/news/winter-2027-fixture';

function row(
  district: RegistrationWindow['district'],
  residentOpenAt: string,
  openAt: string,
  domain: ProgramDomain = 'rec_program',
): RegistrationWindow {
  return {
    id: `${district ?? 'city'}-${domain}`,
    municipality: 'toronto',
    programDomain: domain,
    cycleLabel: 'Winter 2027',
    district,
    previewAt: null,
    residentOpenAt: new Date(residentOpenAt),
    openAt: new Date(openAt),
    residentPriorityDays: 10,
    waitlistResponseHours: 36,
    ageMinMonths: null,
    ageMaxMonths: null,
    sourceUrl: SOURCE,
    verifiedAt: new Date('2026-11-01T05:00:00.000Z'),
    notes: null,
    createdAt: new Date('2026-11-01T05:00:00.000Z'),
    updatedAt: new Date('2026-11-01T05:00:00.000Z'),
  };
}

/** The two published mornings, plus the city-wide row a pre-split seed would leave behind. */
const WINTER: RegistrationWindow[] = [
  row('etobicoke_york', '2026-12-08T07:00:00-05:00', '2026-12-18T07:00:00-05:00'),
  row('toronto_east_york', '2026-12-08T07:00:00-05:00', '2026-12-18T07:00:00-05:00'),
  row('north_york', '2026-12-09T07:00:00-05:00', '2026-12-19T07:00:00-05:00'),
  row('scarborough', '2026-12-09T07:00:00-05:00', '2026-12-19T07:00:00-05:00'),
  row(null, '2026-12-08T07:00:00-05:00', '2026-12-18T07:00:00-05:00'),
];

function firstReply(postal: string): { text: string; district: string | null } {
  const windows = matchRegistrationWindows({
    windows: WINTER,
    postal,
    childrenAgesMonths: [30],
    now: NOW,
  });
  const decision = decideRadar({
    children: [{ name: 'Maya', ageMonths: 30, dobPrecision: 'derived' }],
    candidates: [],
    windows,
    pastCycle: null,
    stillOpenCycle: null,
    weather: [],
    teenChildIds: [],
    healthChildren: [],
    areaCoarse: postal.slice(0, 3),
    suppressedCheckpointRefs: new Set(),
    now: NOW,
    timeZone: 'America/Toronto',
  });
  return {
    text: renderRadarDeterministically(decision, ''),
    district: windows[0]?.window.district ?? null,
  };
}

describe('a Toronto district morning on the first radar reply (VIL-360)', () => {
  it('names the North York morning for an M2N family, not the Etobicoke one', () => {
    const reply = firstReply('M2N 2K8');
    expect(reply.district).toBe('north_york');
    expect(reply.text).toContain('Toronto Winter 2027 registration opens');
    expect(reply.text).toContain('Dec 9');
    expect(reply.text).not.toContain('Dec 8');
  });

  it('keeps the Tuesday morning for Etobicoke and downtown', () => {
    for (const postal of ['M8V 1A1', 'M5V 3A8']) {
      const reply = firstReply(postal);
      expect(reply.text, postal).toContain('Dec 8');
      expect(reply.text, postal).not.toContain('Dec 9');
    }
    expect(firstReply('M8V 1A1').district).toBe('etobicoke_york');
    expect(firstReply('M5V 3A8').district).toBe('toronto_east_york');
  });
});
