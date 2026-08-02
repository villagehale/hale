import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseBiblioCommonsEvents } from './bibliocommons';
import { LIBRARY_SYSTEMS } from './library-systems';
import type { CivicHarvest, CivicSessionRecord } from './types';

/**
 * VIL-252 · M16 — Tier ① library calendars, against REAL captured payloads.
 *
 * Every expectation below is derived from the library's own published data (the
 * fixture is an unedited slice of the live BiblioCommons gateway response), never
 * from what the parser currently returns. The wall-clock times are transcribed
 * from `definition.start`, and the UTC instants are computed from the America/
 * Toronto rule independently — August is UTC-4, December is UTC-5. If the parser
 * ever reads the wrong field, applies a fixed offset, or drops the zone, these
 * fail. Wrong time is the one failure that actually costs a parent a morning.
 */

function fixture(system: string): unknown {
  return JSON.parse(readFileSync(join(__dirname, 'fixtures', `${system}-events.json`), 'utf8'));
}

const tpl = () => parseBiblioCommonsEvents(LIBRARY_SYSTEMS.tpl, fixture('tpl'));
const markham = () => parseBiblioCommonsEvents(LIBRARY_SYSTEMS.markham, fixture('markham'));
const rhpl = () => parseBiblioCommonsEvents(LIBRARY_SYSTEMS.rhpl, fixture('rhpl'));

const byTitle = (harvest: CivicHarvest, title: string): CivicSessionRecord[] =>
  harvest.sessions.filter((s) => s.title === title);

/** The one session with this title; fails loudly if the fixture has none. */
const one = (harvest: CivicHarvest, title: string): CivicSessionRecord => {
  const [session] = byTitle(harvest, title);
  if (session === undefined) throw new Error(`fixture has no session titled "${title}"`);
  return session;
};

describe('parseBiblioCommonsEvents — times', () => {
  it('reads the summer instant as EDT (UTC-4)', () => {
    // RHPL publishes "Family Storytime (0–6 yrs)" at 10:30 on 2026-08-04, Toronto.
    const session = byTitle(rhpl(), 'Family Storytime (0–6 yrs)').find(
      (s) => s.startsAt?.toISOString() === '2026-08-04T14:30:00.000Z',
    );
    expect(session).toBeDefined();
    expect(session?.endsAt?.toISOString()).toBe('2026-08-04T15:00:00.000Z');
  });

  it('reads the winter instant as EST (UTC-5) — a fixed offset would be an hour out', () => {
    // Markham publishes "Chess Meet Up for Children (drop-in)" at 13:30 on 2026-12-13.
    const session = one(markham(), 'Chess Meet Up for Children (drop-in)');
    expect(session.startsAt?.toISOString()).toBe('2026-12-13T18:30:00.000Z');
    expect(session.endsAt?.toISOString()).toBe('2026-12-13T19:30:00.000Z');
  });

  it('emits library events in the dated `occurrence` shape, never the weekly one', () => {
    for (const session of tpl().sessions) {
      expect(session.recurrence).toBe('occurrence');
      expect(session.startsAt).not.toBeNull();
      expect(session.endsAt).not.toBeNull();
      expect(session.dayOfWeek).toBeNull();
      expect(session.startMinute).toBeNull();
      expect(session.endMinute).toBeNull();
      expect(session.endsAt?.getTime() ?? 0).toBeGreaterThan(session.startsAt?.getTime() ?? 0);
    }
  });
});

describe('parseBiblioCommonsEvents — who it is for', () => {
  it('never surfaces adult-only programming as civic family programming', () => {
    const titles = tpl().sessions.map((s) => s.title);
    // Both are real TPL events in the fixture, both audience "Adults (18+)".
    expect(titles).not.toContain('Housing Help');
    expect(titles).not.toContain('Culture & Technology Book Club: End Times by Peter Turchin');
  });

  it('maps each system’s own audience vocabulary to the same age band in months', () => {
    // Three systems, two different words for the same under-6 audience — and
    // neither event states an age of its own, so the umbrella is all there is.
    const tplPreschool = one(tpl(), 'Family Time'); // "Preschool Children (0-5)"
    expect([tplPreschool.ageMinMonths, tplPreschool.ageMaxMonths]).toEqual([0, 71]);

    const mkStorytime = one(markham(), 'Storytime'); // "Birth to Five"
    expect([mkStorytime.ageMinMonths, mkStorytime.ageMaxMonths]).toEqual([0, 71]);
  });

  it('NARROWS the audience umbrella to the age the event itself states', () => {
    // The 0–5 umbrella is what put a 2-year-old in an infant lap-bounce. The
    // event's own title says 0–12 months, and that is the source's real claim.
    const rhBaby = one(rhpl(), 'Babytime (0–12 months)'); // "Babies, Toddlers & Preschool"
    expect([rhBaby.ageMinMonths, rhBaby.ageMaxMonths]).toEqual([0, 12]);

    // RHPL states the band in the title; the intersection keeps the umbrella's
    // ceiling when the stated range runs past it (0–6 yrs ∩ 0–5 yrs).
    const rhFamily = one(rhpl(), 'Stories and Crafts (2–5 yrs)');
    expect([rhFamily.ageMinMonths, rhFamily.ageMaxMonths]).toEqual([24, 71]);
  });

  it('reads a band stated ONLY in the DESCRIPTION, which is where TPL puts it', () => {
    // Markham files this under Children AND Youth — a 6-to-17 union — while its own
    // description says "between the ages of 6 to 12". Nothing in the title says so.
    const club = one(markham(), 'Newcomer Youth Love of Language Club');
    expect([club.ageMinMonths, club.ageMaxMonths]).toEqual([72, 155]);
    // The description is read, never republished: the summary a parent sees is
    // still composed from facts, not from the library's marketing copy.
    expect(club.summary).toBeNull();
  });

  it('unions the band when an event names several audiences and states none itself', () => {
    // TPL "Puppet Show" is Preschool (0-5) AND School Age (6-12) → 0..155 months,
    // and its description says only "children of all ages" — no number to read.
    const puppet = one(tpl(), 'Puppet Show: Goldilocks and the Three Bears');
    expect([puppet.ageMinMonths, puppet.ageMaxMonths]).toEqual([0, 155]);
  });

  it('leaves an all-ages audience unbounded rather than inventing a band', () => {
    // RHPL "Families" states no age at all — so neither do we.
    const craft = one(rhpl(), 'Craftivities: Spooky Family Fun');
    expect(craft.ageMinMonths).toBeNull();
    expect(craft.ageMaxMonths).toBeNull();
  });

  it('SKIPS an event whose audience the registry does not know, and counts it', () => {
    // The silent-drop landmine: a system adding a new audience must make coverage
    // visibly incomplete, never quietly reclassify the event as all-ages.
    const payload = fixture('rhpl') as {
      entities: { events: Record<string, { definition: { audienceIds: string[] } }> };
      events: { items: string[] };
    };
    const victim = payload.events.items[0] ?? '';
    const target = payload.entities.events[victim];
    if (target === undefined) throw new Error('fixture has no events to mutate');
    target.definition.audienceIds = ['an-audience-added-next-year'];

    const harvest = parseBiblioCommonsEvents(LIBRARY_SYSTEMS.rhpl, payload);
    expect(harvest.sessions.map((s) => s.externalId)).not.toContain(victim);
    expect(harvest.unknownAudienceIds).toContain('an-audience-added-next-year');
  });

  it('SKIPS an event that states no audience at all', () => {
    const payload = fixture('rhpl') as {
      entities: { events: Record<string, { definition: { audienceIds: string[] } }> };
      events: { items: string[] };
    };
    const victim = payload.events.items[0] ?? '';
    const target = payload.entities.events[victim];
    if (target === undefined) throw new Error('fixture has no events to mutate');
    target.definition.audienceIds = [];

    const harvest = parseBiblioCommonsEvents(LIBRARY_SYSTEMS.rhpl, payload);
    expect(harvest.sessions.map((s) => s.externalId)).not.toContain(victim);
  });
});

describe('parseBiblioCommonsEvents — provenance and honesty', () => {
  it('keeps a cancelled session as a marked row rather than dropping it silently', () => {
    const cancelled = rhpl().sessions.filter((s) => s.isCancelled);
    expect(cancelled.length).toBeGreaterThan(0);
    expect(cancelled.map((s) => s.title)).toContain('Family Storytime (0–6 yrs)');
  });

  it('marks structured rows as fully confident and free, with no model involved', () => {
    for (const session of markham().sessions) {
      expect(session.extraction).toBe('structured');
      expect(session.confidence).toBe(1);
      expect(session.isFree).toBe(true);
    }
  });

  it('does not treat a seat cap as a registration requirement', () => {
    // Markham stamps maxSeats=1 on programs its own description calls "Drop-in
    // program" (verified in the fixture), so a cap cannot mean "must register".
    const storytime = one(markham(), 'Storytime');
    expect(storytime.registrationRequired).toBe(false);
  });

  it('points every session at the event’s own public page', () => {
    const storytime = one(markham(), 'Storytime');
    expect(storytime.sourceUrl).toBe(
      `https://markham.bibliocommons.com/events/${storytime.externalId}`,
    );
  });
});

describe('parseBiblioCommonsEvents — venues', () => {
  it('builds the branch registry from the payload, with public address and coords', () => {
    const armour = tpl().venues.find((v) => v.externalId === 'AH');
    expect(armour).toMatchObject({
      system: 'tpl',
      kind: 'library_branch',
      name: 'Armour Heights',
      city: 'Toronto',
      postalCode: 'M5M 4M7',
      url: 'https://tpl.ca/locations/AH',
    });
    expect(armour?.address).toBe('2140 Avenue Road');
    expect(armour?.lat).toBeCloseTo(43.7393349, 6);
    expect(armour?.lng).toBeCloseTo(-79.4219493, 6);
  });

  it('emits only the branches its surfaced sessions actually reference', () => {
    const harvest = rhpl();
    const referenced = new Set(harvest.sessions.map((s) => s.venueExternalId));
    for (const venue of harvest.venues) {
      expect(referenced.has(venue.externalId)).toBe(true);
    }
  });

  it('links every session to a venue that is present in the same harvest', () => {
    for (const harvest of [tpl(), markham(), rhpl()]) {
      const ids = new Set(harvest.venues.map((v) => v.externalId));
      for (const session of harvest.sessions) {
        expect(ids.has(session.venueExternalId)).toBe(true);
      }
    }
  });
});
