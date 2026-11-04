import { context, propagation, trace } from '@opentelemetry/api';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { register } from '~/instrumentation';
import { localParts } from '~/lib/loop/prefs';
import { timezoneOffsetMs } from '~/lib/memory/period';
import { type OffsetReader, type TzdataCheck, checkTzdata, reportTzdataAtBoot } from './tzdata';

// Every expected offset is hand-derived from the IANA tz 2026f source (eggert/tz tag 2026f):
// the final Zone continuation line in `northamerica` (the rule in force after
// 2026-11-01 02:00), hours × 60, or the Link line in `backward` for a link zone.
const STALE = `runtime tzdata ${process.versions.tz} (node ${process.version}) predates 2026e: switch Node; not caused by your change`;

describe('runtime tzdata through the real timezoneOffsetMs, 2026-12-15T12:00Z', () => {
  it.each([
    // Changed in 2026: a 2025b runtime reads each of these one hour west.
    ['America/Vancouver', -420], // northamerica:2223 "-7:00 - MST" (2026b)
    ['America/Edmonton', -360], // northamerica:2091 "-6:00 - CST" (2026c)
    ['America/Yellowknife', -360], // backward:283 "Link America/Edmonton America/Yellowknife"
    ['America/Inuvik', -360], // northamerica:2613 "-6:00 - CST" (2026d)
    ['America/Winnipeg', -300], // northamerica:1892 "-5:00 - EST" (2026e)
    ['America/Rainy_River', -300], // backward:278 "Link America/Winnipeg America/Rainy_River"
    // Unchanged positive controls: green on any runtime, so a red above is the data, not the harness.
    ['America/Fort_Nelson', -420], // northamerica:2233 "-7:00 - MST" (since 2015)
    ['America/Dawson_Creek', -420], // northamerica:2227 "-7:00 - MST" (since 1972)
    ['America/Creston', -420], // backward:195 "Link America/Phoenix America/Creston"; northamerica:828 "-7:00 - MST"
    ['America/Regina', -360], // northamerica:2004 "-6:00 - CST"
    ['America/Chicago', -360], // northamerica:438 "-6:00 US C%sT" (CST in December)
    ['America/Halifax', -240], // northamerica:1565 "-4:00 Canada A%sT" (AST in December)
  ])('%s is %i minutes from UTC', (zone, expectedMinutes) => {
    const minutes = timezoneOffsetMs(new Date('2026-12-15T12:00:00Z'), zone) / 60_000;
    expect(minutes, STALE).toBe(expectedMinutes);
  });

  it('checkTzdata() with its default reader reports current data', () => {
    expect(checkTzdata().outcome, STALE).toBe('tzdata_current');
  });
});

describe('localParts reads the family wall clock on current data', () => {
  // 2026-12-15 is a Tuesday (weekday 2). Each instant is 10:00 local on current data.
  it.each([
    ['2026-12-15T17:00:00Z', 'America/Vancouver'], // 17:00Z − 7 h
    ['2026-12-15T16:00:00Z', 'America/Edmonton'], // 16:00Z − 6 h
    ['2026-12-15T15:00:00Z', 'America/Winnipeg'], // 15:00Z − 5 h
    ['2026-12-15T16:00:00Z', 'America/Chicago'], // positive control: unchanged, 16:00Z − 6 h
  ])('%s in %s is Tuesday 10:00', (instant, zone) => {
    expect(localParts(new Date(instant), zone), STALE).toEqual({ weekday: 2, minutes: 600 });
  });
});

const MINUTE_MS = 60_000;

function readerFrom(minutesByZone: Record<string, number>): OffsetReader {
  return (_instant, zone) => {
    const minutes = minutesByZone[zone];
    if (minutes === undefined) throw new Error(`fake reader has no row for ${zone}`);
    return minutes * MINUTE_MS;
  };
}

// The four sentinels as the tz 2026f source states them (see the table above).
const CURRENT = {
  'America/Vancouver': -420,
  'America/Edmonton': -360,
  'America/Inuvik': -360,
  'America/Winnipeg': -300,
};
// What a 2025b database answers for the same instant: each zone one hour west.
const TZ_2025B = {
  'America/Vancouver': -480,
  'America/Edmonton': -420,
  'America/Inuvik': -420,
  'America/Winnipeg': -360,
};
const VERSIONS = { tz: '2026e', icu: '78.3' };

describe('checkTzdata with an injected reader', () => {
  it('names every sentinel a 2025b database gets wrong', () => {
    expect(checkTzdata(readerFrom(TZ_2025B), VERSIONS)).toEqual({
      outcome: 'tzdata_stale',
      tz: '2026e',
      icu: '78.3',
      mismatches: [
        { zone: 'America/Vancouver', expectedMinutes: -420, actual: -480 },
        { zone: 'America/Edmonton', expectedMinutes: -360, actual: -420 },
        { zone: 'America/Inuvik', expectedMinutes: -360, actual: -420 },
        { zone: 'America/Winnipeg', expectedMinutes: -300, actual: -360 },
      ],
    });
  });

  it('reports current when every sentinel matches', () => {
    expect(checkTzdata(readerFrom(CURRENT), VERSIONS)).toEqual({
      outcome: 'tzdata_current',
      tz: '2026e',
      icu: '78.3',
    });
  });

  it('maps a RangeError and a NaN offset to unreadable without throwing', () => {
    const base = readerFrom(CURRENT);
    const reader: OffsetReader = (instant, zone) => {
      if (zone === 'America/Edmonton') throw new RangeError('Invalid time zone specified');
      if (zone === 'America/Winnipeg') return Number.NaN;
      return base(instant, zone);
    };
    const check = checkTzdata(reader, VERSIONS);
    expect(check).toEqual({
      outcome: 'tzdata_stale',
      tz: '2026e',
      icu: '78.3',
      mismatches: [
        { zone: 'America/Edmonton', expectedMinutes: -360, actual: 'unreadable' },
        { zone: 'America/Winnipeg', expectedMinutes: -300, actual: 'unreadable' },
      ],
    });
  });

  it('lets any other error propagate', () => {
    const reader: OffsetReader = () => {
      throw new Error('not an ICU range error');
    };
    expect(() => checkTzdata(reader, VERSIONS)).toThrow('not an ICU range error');
  });

  it('names absent version strings as not_reported', () => {
    expect(checkTzdata(readerFrom(CURRENT), {})).toEqual({
      outcome: 'tzdata_current',
      tz: 'not_reported',
      icu: 'not_reported',
    });
  });
});

describe('reportTzdataAtBoot', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs tzdata_stale as an error with the mismatches', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const stale: TzdataCheck = {
      outcome: 'tzdata_stale',
      tz: '2025b',
      icu: '77.1',
      mismatches: [{ zone: 'America/Vancouver', expectedMinutes: -420, actual: -480 }],
    };

    expect(reportTzdataAtBoot(stale)).toBe(stale);

    expect(error).toHaveBeenCalledTimes(1);
    const [payload, message] = error.mock.calls[0] as [Record<string, unknown>, string];
    expect(payload).toMatchObject({
      code: 'tzdata_stale',
      tz: '2025b',
      icu: '77.1',
      mismatches: stale.mismatches,
    });
    expect(message.startsWith('tzdata_stale')).toBe(true);
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]?.[0]).toMatchObject({ outcome: 'tzdata_stale', tz: '2025b' });
  });

  it('logs one info line and no error when current', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    reportTzdataAtBoot({ outcome: 'tzdata_current', tz: '2026e', icu: '78.3' });

    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]).toEqual([
      { tz: '2026e', icu: '78.3', node: process.version, outcome: 'tzdata_current' },
      'tzdata: runtime time-zone data',
    ]);
    expect(error).not.toHaveBeenCalled();
  });
});

describe('instrumentation register() runs the boot check', () => {
  const TZDATA_LINE = 'tzdata: runtime time-zone data';
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ['NEXT_RUNTIME', 'POSTHOG_PROJECT_API_KEY']) saved[key] = process.env[key];
    // With the key set, register() installs process-level error handlers that would
    // outlive this file.
    Reflect.deleteProperty(process.env, 'POSTHOG_PROJECT_API_KEY');
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
    vi.restoreAllMocks();
  });

  afterAll(() => {
    // register() installs a global tracer provider; keep it out of later files in this worker.
    trace.disable();
    context.disable();
    propagation.disable();
  });

  function tzdataLines(info: ReturnType<typeof vi.spyOn>): number {
    return info.mock.calls.filter((call) => call[1] === TZDATA_LINE).length;
  }

  it('logs the tzdata line once on the nodejs runtime', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.NEXT_RUNTIME = 'nodejs';

    await register();

    expect(tzdataLines(info)).toBe(1);
  });

  it('logs nothing about tzdata on the edge runtime', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    process.env.NEXT_RUNTIME = 'edge';

    await register();

    expect(tzdataLines(info)).toBe(0);
  });
});
