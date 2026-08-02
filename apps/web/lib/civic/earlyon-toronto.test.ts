import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createEarlyOnTorontoAdapter } from './earlyon-toronto';
import { parseHoursStrict } from './hours-text';
import type { ParsedHours } from './parse-hours';

/**
 * VIL-252 · M16 · Tier ② — the Toronto EarlyON adapter over the City's own open
 * data (CKAN resource 7326e338, "EarlyON Child and Family Centres Locations").
 *
 * The fixture is an unedited slice of that live feed. No model runs here: the
 * parse seam is injected, so these tests pin the ADAPTER's behaviour (venues,
 * slot→session mapping, age policy, provenance) while the parser's own quality is
 * an eval against real cached Claude (rule #8).
 */

const fixture = () =>
  JSON.parse(readFileSync(join(__dirname, 'fixtures', 'earlyon-toronto-centres.json'), 'utf8'));

/**
 * The deterministic half of the real parser, with the LLM fallback replaced by a
 * throw. Every record in the fixture is well-formed municipal text, so this
 * passing IS the claim that the current EarlyON corpus costs zero model calls —
 * if a future fixture needs the model, this fails loudly instead of quietly
 * spending.
 */
const noModel = async (text: string): Promise<ParsedHours> => {
  const slots = parseHoursStrict(text);
  if (slots === null) {
    throw new Error(`the model must not be needed for well-formed hours: ${text}`);
  }
  return { slots, confidence: 1, extraction: 'structured', rejected: 0 };
};

const harvest = (parse = noModel) =>
  createEarlyOnTorontoAdapter({ parseHours: parse }).harvest(async () => fixture());

describe('createEarlyOnTorontoAdapter — venues', () => {
  it('registers each centre with its public address and coordinates', async () => {
    const { venues } = await harvest();
    const spruce = venues.find((v) => v.externalId === '13650');
    expect(spruce).toMatchObject({
      system: 'earlyon_toronto',
      kind: 'earlyon_centre',
      name: '101 Spruce St EarlyON Child and Family Centre',
      city: 'Toronto',
      postalCode: 'M5A 2J3',
    });
    expect(spruce?.address).toBe('101 Spruce St');
    expect(spruce?.lat).toBeCloseTo(43.664194, 5);
  });

  it('reads the postal code out of the full address rather than inventing one', async () => {
    const { venues } = await harvest();
    // "1102 Broadview Ave, East York, ON M4K 2S5"
    const abiona = venues.find((v) => v.externalId === '12549');
    expect(abiona?.postalCode).toBe('M4K 2S5');
    expect(abiona?.city).toBe('East York');
  });
});

describe('createEarlyOnTorontoAdapter — sessions', () => {
  it('emits weekly slots in the `weekly` shape, never the dated one', async () => {
    const { sessions } = await harvest();
    expect(sessions.length).toBeGreaterThan(0);
    for (const session of sessions) {
      expect(session.recurrence).toBe('weekly');
      expect(session.startsAt).toBeNull();
      expect(session.endsAt).toBeNull();
      expect(session.dayOfWeek).not.toBeNull();
      expect(session.endMinute!).toBeGreaterThan(session.startMinute!);
    }
  });

  it('turns one centre’s published drop-in hours into one session per slot', async () => {
    const { sessions } = await harvest();
    // 13423 Bathurst-Finch: "Monday: 9:30 a.m. - 11:30 a.m.  ; 1:30 p.m. - 3:30 p.m."
    const slots = sessions.filter((s) => s.venueExternalId === '13423');
    expect(slots).toHaveLength(2);
    expect(slots.map((s) => [s.dayOfWeek, s.startMinute, s.endMinute])).toEqual([
      [1, 9 * 60 + 30, 11 * 60 + 30],
      [1, 13 * 60 + 30, 15 * 60 + 30],
    ]);
  });

  it('separates drop-in from registered programming, and marks which is which', async () => {
    const { sessions } = await harvest();
    // 13650: drop-in Wednesday, registered Thursday — same times, different days
    // and very different things to tell a parent.
    const spruce = sessions.filter((s) => s.venueExternalId === '13650');
    const dropIn = spruce.find((s) => !s.registrationRequired);
    const registered = spruce.find((s) => s.registrationRequired);
    expect(dropIn?.dayOfWeek).toBe(3);
    expect(registered?.dayOfWeek).toBe(4);
    expect(dropIn?.title).toContain('drop-in');
  });

  it('gives each slot a stable id so a re-sweep updates rather than duplicates', async () => {
    const first = await harvest();
    const second = await harvest();
    const ids = (h: Awaited<ReturnType<typeof harvest>>) =>
      h.sessions.map((s) => `${s.venueExternalId}/${s.externalId}`);
    expect(ids(first)).toEqual(ids(second));
    expect(new Set(ids(first)).size).toBe(ids(first).length);
  });

  it('applies EarlyON’s statutory birth-to-six age band to every session', async () => {
    const { sessions } = await harvest();
    for (const session of sessions) {
      expect(session.ageMinMonths).toBe(0);
      expect(session.ageMaxMonths).toBe(71);
    }
  });

  it('marks every session free — EarlyON programming is free by statute', async () => {
    const { sessions } = await harvest();
    for (const session of sessions) {
      expect(session.isFree).toBe(true);
    }
  });

  it('carries the City open-data source on every row, with structured confidence', async () => {
    const { sessions } = await harvest();
    for (const session of sessions) {
      expect(session.sourceUrl).toContain('open.toronto.ca');
      expect(session.extraction).toBe('structured');
      expect(session.confidence).toBe(1);
    }
  });
});

describe('createEarlyOnTorontoAdapter — degradation', () => {
  it('falls back to the injected parser when the text is not well-formed', async () => {
    const calls: string[] = [];
    const parse = async (text: string): Promise<ParsedHours> => {
      calls.push(text);
      return {
        slots: [{ dayOfWeek: 2, startMinute: 600, endMinute: 660 }],
        confidence: 0.85,
        extraction: 'llm',
        rejected: 1,
      };
    };
    const irregular = fixture();
    irregular.result.records = [
      {
        ...irregular.result.records[0],
        dropinHours: 'Tuesdays mid-morning, roughly an hour — please call ahead',
        registeredHours: null,
      },
    ];
    const adapter = createEarlyOnTorontoAdapter({ parseHours: parse });
    const { sessions } = await adapter.harvest(async () => irregular);

    expect(calls).toHaveLength(1);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      dayOfWeek: 2,
      extraction: 'llm',
      confidence: 0.85,
    });
  });

  it('produces no sessions for a centre that publishes no hours at all', async () => {
    const blank = fixture();
    blank.result.records = [
      { ...blank.result.records[0], dropinHours: null, registeredHours: null, virtualHours: null },
    ];
    const adapter = createEarlyOnTorontoAdapter({ parseHours: noModel });
    const { sessions, venues } = await adapter.harvest(async () => blank);
    expect(sessions).toEqual([]);
    // The centre is still registered — it exists, we just know no times for it.
    expect(venues).toHaveLength(1);
  });
});
