import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isSyntheticProbeNumber } from '~/lib/channels/phone';
import {
  PERSONAS,
  parseArgs,
  personaFrom,
  plannedSpend,
  turnWorstUsd,
} from '../../scripts/preview-fake-family.mjs';

const FLYERS = new URL('../../scripts/qa-flyers/', import.meta.url);

describe('preview-fake-family personas (VIL-469)', () => {
  it('carries the five VIL-466 personas at their turn counts, plus the reminder proof', () => {
    const shape = Object.fromEntries(
      Object.entries(PERSONAS).map(([name, p]) => [
        name,
        { turns: p.turns.length, photos: p.turns.filter((t) => t.media).length },
      ]),
    );
    expect(shape).toEqual({
      impatient: { turns: 6, photos: 0 },
      french: { turns: 12, photos: 0 },
      chinese: { turns: 12, photos: 0 },
      photos: { turns: 12, photos: 4 },
      optout: { turns: 10, photos: 0 },
      reminder: { turns: 3, photos: 0 },
    });
    expect(
      Object.entries(PERSONAS)
        .filter(([, p]) => p.fireReminders)
        .map(([n]) => n),
    ).toEqual(['reminder']);
  });

  it('gives every persona and run its own fictional 437-555-01xx number', () => {
    const numbers = Object.keys(PERSONAS).flatMap((name) =>
      [0, 1, 9].map((seq) => personaFrom(name, seq)),
    );
    expect(new Set(numbers).size).toBe(numbers.length);
    for (const n of numbers) {
      expect(isSyntheticProbeNumber(n)).toBe(true);
      expect(n).toMatch(/^\+143755501\d\d$/);
    }
  });

  it('attaches each photo as an https image that exists in qa-flyers', () => {
    const media = Object.values(PERSONAS).flatMap((p) =>
      p.turns.flatMap((t) => t.media ?? []),
    ) as Array<{ file: string; mime: string }>;
    expect(media).toHaveLength(4);
    for (const m of media) {
      expect(m.mime).toBe('image/png');
      expect(existsSync(fileURLToPath(new URL(m.file, FLYERS)))).toBe(true);
    }
    // Positive control: the existence check can fail.
    expect(existsSync(fileURLToPath(new URL('flyer-missing.png', FLYERS)))).toBe(false);
  });
});

describe('preview-fake-family args and budget (VIL-469)', () => {
  it('requires a known persona and bounds --turns by that persona', () => {
    expect(() => parseArgs(['--dry', '--max-usd', '4'])).toThrow(/--persona/);
    expect(() => parseArgs(['--dry', '--max-usd', '4', '--persona', 'nobody'])).toThrow(
      /--persona/,
    );
    expect(() =>
      parseArgs(['--dry', '--max-usd', '4', '--persona', 'impatient', '--turns', '7']),
    ).toThrow(/1\.\.6/);
    expect(parseArgs(['--dry', '--max-usd', '4', '--persona', 'french'])).toMatchObject({
      persona: 'french',
      turns: 12,
      seq: 0,
    });
    expect(
      parseArgs([
        '--live',
        '--max-usd',
        '1',
        '--persona',
        'optout',
        '--turns',
        '3',
        '--seq',
        '4',
        '--deployment',
        'dpl_x',
      ]),
    ).toMatchObject({
      mode: 'live',
      persona: 'optout',
      turns: 3,
      seq: 4,
      maxUsd: 1,
      deployment: 'dpl_x',
    });
    expect(() =>
      parseArgs(['--dry', '--max-usd', '4', '--persona', 'optout', '--seq', '10']),
    ).toThrow(/--seq/);
  });

  it('reserves the worst case of every turn and the reminder compose under the cap', () => {
    const per = turnWorstUsd();
    // Just over three turns' worst case fits the turns but not the reminder trigger.
    const tight = plannedSpend(PERSONAS.reminder, 3, 3 * per + 0.001);
    expect(tight).toMatchObject({ turns: 3, reminder: false });
    const room = plannedSpend(PERSONAS.reminder, 3, 4);
    expect(room.turns).toBe(3);
    expect(room.reminder).toBe(true);
    expect(room.usd).toBeGreaterThan(3 * per);
    expect(room.usd).toBeLessThanOrEqual(4);
    // A persona without the trigger never reserves it.
    expect(plannedSpend(PERSONAS.french, 12, 4)).toMatchObject({
      turns: Math.floor(4 / per),
      reminder: false,
    });
  });
});
