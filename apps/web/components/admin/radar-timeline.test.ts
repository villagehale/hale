import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { opensInDays, RadarTimeline, timelinePercent } from './radar-timeline';

const NOW = '2026-08-31T12:00:00Z';

describe('opensInDays', () => {
  it('counts whole days up, clamping the already-open case to 0', () => {
    expect(opensInDays('2026-09-03T12:00:00Z', NOW)).toBe(3);
    expect(opensInDays('2026-09-01T00:00:00Z', NOW)).toBe(1);
    expect(opensInDays('2026-08-30T12:00:00Z', NOW)).toBe(0);
  });
});

describe('timelinePercent', () => {
  const horizon = '2026-09-10T12:00:00Z';

  it('positions instants proportionally between now and the horizon', () => {
    expect(timelinePercent(NOW, NOW, horizon)).toBe(0);
    expect(timelinePercent(horizon, NOW, horizon)).toBe(100);
    expect(timelinePercent('2026-09-05T12:00:00Z', NOW, horizon)).toBe(50);
  });

  it('clamps out-of-range instants instead of overflowing the track', () => {
    expect(timelinePercent('2026-08-01T12:00:00Z', NOW, horizon)).toBe(0);
    expect(timelinePercent('2027-01-01T12:00:00Z', NOW, horizon)).toBe(100);
  });
});

describe('RadarTimeline render', () => {
  const windows = [
    {
      municipality: 'toronto',
      programDomain: 'rec_program',
      cycleLabel: 'Winter 2027',
      openAt: '2026-12-03T14:00:00Z',
      residentOpenAt: '2026-12-01T14:00:00Z',
      verifiedAt: '2026-08-20T12:00:00Z',
    },
    {
      municipality: 'markham',
      programDomain: 'camp',
      cycleLabel: 'March Break 2027',
      openAt: '2026-09-04T14:00:00Z',
      residentOpenAt: null,
      verifiedAt: null,
    },
  ];

  const html = renderToStaticMarkup(
    createElement(RadarTimeline, { windows, nowIso: NOW }),
  );

  it('labels each window and shows its opens-in chip, amber-wash inside a week', () => {
    expect(html).toContain('toronto · rec program · Winter 2027');
    expect(html).toContain('opens in 95d');
    // markham opens in 5 days → soon → the amber wash chip.
    expect(html).toMatch(/adm-timeline-chip adm-stale[^>]*>opens in 5d/);
  });

  it('marks the resident-priority open with a hollow second dot', () => {
    expect(html).toContain('adm-timeline-dot-resident');
  });

  it('reveals exact Toronto dates on hover via the track title', () => {
    expect(html).toContain('opens Dec 3, 2026 · residents Dec 1, 2026');
  });

  it('renders the honest empty state without a timeline', () => {
    const empty = renderToStaticMarkup(createElement(RadarTimeline, { windows: [] }));
    expect(empty).toContain('No upcoming registration windows on file.');
    expect(empty).not.toContain('adm-timeline-row');
  });
});
