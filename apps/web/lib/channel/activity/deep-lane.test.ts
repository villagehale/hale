import { describe, expect, it, vi } from 'vitest';
import { type DeepLaneDeps, runDeepLane } from './deep-lane';
import type { ActivityQuery } from './deidentify';
import type { AngleLeg, DeepAngle } from './fanout';
import type { SynthesisOutcome, SynthesisRow } from './synthesis';

/**
 * THE LANE, END TO END — with the WEB and the MERGE as ports and everything between them
 * production code.
 *
 * Two properties carry the file. First, a partial fan-out still produces an answer AND
 * the merge is told which angles came back, because "the municipal leg timed out" and
 * "the municipal page carries nothing" are two different facts and only one of them
 * licenses a sentence. Second, whatever the merge proposes, only quote-backed rows come
 * out the other side — the refutation is inside the lane rather than beside it, so no
 * caller can forget to run it.
 */

const QUERY: ActivityQuery = {
  subject: 'Cartwheels Gym Centre fall schedule',
  town: 'Halton Hills',
  stage: 'toddler',
  window: 'this fall',
};

const VENUE_URL = 'https://cartwheelsgymcentre.example/programs';
const VENUE_TEXT =
  'Tiny Gym Sundays 9:30-10:15, Sept 14 to Oct 26. $124 per term. Registration has been open since July 22.';

function leg(angle: DeepAngle, overrides: Partial<AngleLeg> = {}): AngleLeg {
  return {
    angle,
    status: 'read',
    searchResults: 4,
    pagesRead: 1,
    pagesStale: 0,
    pagesRefused: 0,
    pages: [{ url: VENUE_URL, text: VENUE_TEXT }],
    notes: `--- page: ${VENUE_URL} ---\n${VENUE_TEXT}`,
    pagesTruncated: 0,
    reason: null,
    ...overrides,
  };
}

function backedRow(overrides: Partial<SynthesisRow> = {}): SynthesisRow {
  return {
    name: 'Tiny Gym, Cartwheels Gym Centre',
    age_fit: 'walking to 3.5 years',
    when: 'Sundays 9:30-10:15, Sept 14 to Oct 26',
    when_quote: 'Tiny Gym Sundays 9:30-10:15, Sept 14 to Oct 26',
    price: '$124 per term',
    price_quote: '$124 per term',
    registration: 'Open since July 22',
    registration_quote: 'Registration has been open since July 22',
    source_name: 'Cartwheels Gym Centre',
    source_url: VENUE_URL,
    ...overrides,
  };
}

function deps(
  legs: readonly AngleLeg[],
  merged: SynthesisOutcome,
): DeepLaneDeps & { merge: ReturnType<typeof vi.fn> } {
  const byAngle = new Map(legs.map((entry) => [entry.angle, entry]));
  const merge = vi.fn(async () => merged);
  return {
    researcher: {
      async research(_query, angle) {
        const found = byAngle.get(angle);
        if (!found) throw new Error(`no scripted leg for ${angle}`);
        return found;
      },
    },
    synthesiser: { merge },
    merge,
  };
}

describe('runDeepLane', () => {
  it('composes from the legs that came back and tells the merge which one did not', async () => {
    const lane = deps(
      [
        leg('venue_site'),
        leg('municipal', { status: 'failed', pagesRead: 0, pages: [], notes: '', reason: 'research_failed: timed out' }),
        leg('registration', { status: 'unread', pagesRead: 0, pagesRefused: 2, pages: [], notes: '' }),
      ],
      { status: 'synthesised', rows: [backedRow()] },
    );

    const run = await runDeepLane(lane, QUERY);

    expect(run.result.status).toBe('read');
    // The merge is handed EVERY leg with its own status - a failed angle is reported, not
    // omitted, so silence from a leg that never ran cannot read as silence from a page.
    const fanOut = lane.merge.mock.calls[0]?.[1] as { legs: AngleLeg[] };
    expect(fanOut.legs.map((entry) => [entry.angle, entry.status])).toEqual([
      ['venue_site', 'read'],
      ['municipal', 'failed'],
      ['registration', 'unread'],
    ]);
    expect(run.evidence).toMatchObject({ legsRead: 1, legsUnread: 1, legsFailed: 1, picks: 1 });
  });

  it('drops the rows the refutation breaks and counts them in the evidence', async () => {
    const lane = deps(
      [leg('venue_site'), leg('municipal'), leg('registration')],
      {
        status: 'synthesised',
        rows: [
          backedRow(),
          // Cited to a page no leg opened - the #529 citation defect.
          backedRow({ source_url: 'https://invented.example/schedule' }),
          // A fee that is nowhere in the notes.
          backedRow({
            name: 'Kinderfun, Cartwheels Gym Centre',
            price: '$310 per term',
            price_quote: '$310 per term',
            when: null,
            when_quote: null,
            registration: null,
            registration_quote: null,
          }),
        ],
      },
    );

    const run = await runDeepLane(lane, QUERY);

    if (run.result.status !== 'read') throw new Error('expected a read result');
    expect(run.result.slots.map((slot) => slot.name)).toEqual(['Tiny Gym, Cartwheels Gym Centre']);
    expect(run.evidence).toMatchObject({ rowsProposed: 3, picks: 1, slotsRefused: 2 });
    expect(run.refutation?.slotReasons).toMatchObject({ uncited_page: 1, no_backed_fact: 1 });
  });

  it('never calls the merge when no angle opened a page, and says UNREAD', async () => {
    const unread = { status: 'unread' as const, pagesRead: 0, pagesRefused: 2, pages: [], notes: '' };
    const lane = deps(
      [leg('venue_site', unread), leg('municipal', unread), leg('registration', unread)],
      { status: 'synthesised', rows: [backedRow()] },
    );

    const run = await runDeepLane(lane, QUERY);

    expect(run.result).toEqual({ status: 'unread', searchResults: 12, pagesRefused: 6 });
    expect(lane.merge).not.toHaveBeenCalled();
  });

  it('separates every-leg-failed from every-leg-opened-nothing', async () => {
    const dead = {
      status: 'failed' as const,
      searchResults: 0,
      pagesRead: 0,
      pages: [],
      notes: '',
      reason: 'research_failed: timed out',
    };
    const lane = deps(
      [leg('venue_site', dead), leg('municipal', dead), leg('registration', dead)],
      { status: 'synthesised', rows: [] },
    );

    const run = await runDeepLane(lane, QUERY);

    expect(run.result).toEqual({ status: 'unavailable', reason: 'research_failed' });
    expect(lane.merge).not.toHaveBeenCalled();
  });

  it('reports a merge failure in the vocabulary every existing reader already counts', async () => {
    const lane = deps([leg('venue_site'), leg('municipal'), leg('registration')], {
      status: 'unavailable',
      reason: 'synthesis_failed',
    });

    const run = await runDeepLane(lane, QUERY);

    expect(run.result).toEqual({ status: 'unavailable', reason: 'extract_failed' });
  });

  it('checks quotes against the BOUNDED page text the merge was handed, not more', async () => {
    // The leg cut this page at 20 characters, so a fact quoted from beyond the cut is a
    // fact the merge cannot have read - and must not be able to claim.
    const cut = leg('venue_site', {
      pages: [{ url: VENUE_URL, text: VENUE_TEXT.slice(0, 20) }],
      pagesTruncated: 1,
    });
    const lane = deps([cut, leg('municipal', cut), leg('registration', cut)], {
      status: 'synthesised',
      rows: [backedRow()],
    });

    const run = await runDeepLane(lane, QUERY);

    if (run.result.status !== 'read') throw new Error('expected a read result');
    expect(run.result.slots).toEqual([]);
    expect(run.evidence.slotsRefused).toBe(1);
  });
});
