import { describe, expect, it } from 'vitest';
import { MAX_NUDGE_SEGMENTS, NUDGE_OPT_OUT } from '~/lib/channel/nudge/shell';
import { smsEncoding, smsSegments } from '~/lib/channel/sms-segments';
import type { Shortlist } from './shortlist.js';
import {
  renderCheckInReply,
  renderSequenceLeg,
  renderShortlistRationale,
} from './copy.js';

/**
 * VIL-242 · M7 — every string this feature can put in front of a parent.
 *
 * Three properties are checked on all of them, because each has bitten this codebase:
 *
 *   1. GSM-7 ONLY. One curly apostrophe or en dash flips the whole SMS to UCS-2 and
 *      halves the budget, for a difference nobody can see on a phone.
 *   2. TWO SEGMENTS INCLUDING THE OPT-OUT. The longest real source URL in the M1
 *      dataset is 121 characters, so the budget is checked against that, not a short
 *      placeholder that would pass and then blow up in Toronto.
 *   3. NO INVENTED PROGRAM. The copy may name the municipality, the cycle, the domain,
 *      the time and the link — never a class.
 */

const TZ = 'America/Toronto';
const NOW = new Date('2026-09-14T22:00:00.000Z');

/** The longest source URL in the real M1 dataset (Toronto, 121 characters). */
const LONGEST_URL =
  'https://www.toronto.ca/explore-enjoy/parks-recreation/program-activities/camps-after-school/after-school-recreation-care/';

function shortlist(overrides: Partial<Shortlist> = {}): Shortlist {
  return {
    windowRef: {
      id: 'win-1',
      municipality: 'richmond_hill',
      programDomain: 'rec_program',
      cycleLabel: 'Fall 2026',
    },
    programDomainLabel: 'recreation programs',
    opensForFamilyAt: new Date('2026-09-15T10:30:00.000Z'),
    sourceUrl: LONGEST_URL,
    isResidentWindow: false,
    residentPriorityDays: null,
    waitlistResponseHours: 36,
    fitNotes: [{ childId: 'c1', name: 'Max', fit: 'in_band' }],
    ageApproximate: false,
    ...overrides,
  };
}

const LEG_INPUT = { shortlist: shortlist(), timeZone: TZ, now: NOW, optIn: 'opted_in' } as const;

function withOptOut(body: string): string {
  return `${body}\n\n${NUDGE_OPT_OUT}`;
}

describe('renderSequenceLeg', () => {
  const legs = ['heads_up', 'battle_plan', 'go', 'check_in'] as const;

  it.each(legs)('renders %s inside the segment budget, in GSM-7', (leg) => {
    const body = renderSequenceLeg(leg, LEG_INPUT);
    expect(smsEncoding(withOptOut(body))).toBe('gsm7');
    expect(smsSegments(withOptOut(body))).toBeLessThanOrEqual(MAX_NUDGE_SEGMENTS);
  });

  it('never writes the opt-out itself — the sender appends it exactly once', () => {
    for (const leg of legs) {
      expect(renderSequenceLeg(leg, LEG_INPUT)).not.toContain(NUDGE_OPT_OUT);
    }
  });

  it('names the town, the cycle and the family-local open time in the heads-up', () => {
    const body = renderSequenceLeg('heads_up', LEG_INPUT);
    expect(body).toContain('Richmond Hill');
    expect(body).toContain('Fall 2026');
    expect(body).toContain('6:30 a.m.');
    expect(body).toContain('Max');
  });

  it('asks a pending family to approve the shortlist and does not ask an opted-in one', () => {
    expect(renderSequenceLeg('heads_up', { ...LEG_INPUT, optIn: 'pending' })).toContain('approve');
    expect(renderSequenceLeg('heads_up', LEG_INPUT)).not.toContain('approve');
  });

  it('hedges the heads-up when the match rests on a spoken-age tolerance', () => {
    const hedged = renderSequenceLeg('heads_up', {
      ...LEG_INPUT,
      shortlist: shortlist({ ageApproximate: true }),
    });
    expect(hedged).toContain('if');
    expect(renderSequenceLeg('heads_up', LEG_INPUT)).not.toContain('if');
  });

  it('names the resident head start only where the family has one', () => {
    const resident = renderSequenceLeg('heads_up', {
      ...LEG_INPUT,
      shortlist: shortlist({ isResidentWindow: true, residentPriorityDays: 7 }),
    });
    expect(resident).toContain('residents');
    expect(renderSequenceLeg('heads_up', LEG_INPUT)).not.toContain('residents');
  });

  it('carries the direct municipal link on the battle plan and the go, not the heads-up', () => {
    expect(renderSequenceLeg('battle_plan', LEG_INPUT)).toContain(LONGEST_URL);
    expect(renderSequenceLeg('go', LEG_INPUT)).toContain(LONGEST_URL);
    // The heads-up is a week out; a link nobody can use yet just eats the budget the
    // hedge and the kids' names need.
    expect(renderSequenceLeg('heads_up', LEG_INPUT)).not.toContain(LONGEST_URL);
  });

  it('tells the check-in exactly which three answers it can read', () => {
    const body = renderSequenceLeg('check_in', LEG_INPUT);
    expect(body.toLowerCase()).toContain('got in');
    expect(body.toLowerCase()).toContain('waitlisted');
    expect(body.toLowerCase()).toContain('missed');
  });

  it('keeps a 13+ child nameless in every leg — rule #1', () => {
    const teen = { ...LEG_INPUT, shortlist: shortlist({ fitNotes: [{ childId: 'c1', name: null, fit: 'in_band' as const }] }) };
    for (const leg of legs) {
      const body = renderSequenceLeg(leg, teen);
      expect(body).not.toContain('null');
      expect(body).not.toContain('undefined');
    }
    // The generic task naming still says WHOSE registration it is, without a name.
    expect(renderSequenceLeg('heads_up', teen)).toContain('your teen');
  });

  it('names two children in one line rather than sending two messages', () => {
    const body = renderSequenceLeg('heads_up', {
      ...LEG_INPUT,
      shortlist: shortlist({
        fitNotes: [
          { childId: 'c1', name: 'Max', fit: 'in_band' },
          { childId: 'c2', name: 'Mia', fit: 'in_band' },
        ],
      }),
    });
    expect(body).toContain('Max and Mia');
  });

  it('stays inside the budget for a three-kid family on the longest URL', () => {
    const body = renderSequenceLeg('battle_plan', {
      ...LEG_INPUT,
      shortlist: shortlist({
        fitNotes: [
          { childId: 'c1', name: 'Sebastian', fit: 'in_band' },
          { childId: 'c2', name: 'Genevieve', fit: 'in_band' },
          { childId: 'c3', name: 'Maximilian', fit: 'near_band' },
        ],
      }),
    });
    expect(smsSegments(withOptOut(body))).toBeLessThanOrEqual(MAX_NUDGE_SEGMENTS);
  });
});

describe('waitlist guard copy', () => {
  const DEADLINE = new Date('2026-09-17T03:00:00.000Z');
  const waitlistInput = {
    ...LEG_INPUT,
    now: new Date('2026-09-16T09:00:00.000Z'),
    waitlist: { position: 12, deadlineAt: DEADLINE },
  };

  it('renders both guards inside the segment budget, in GSM-7', () => {
    for (const leg of ['waitlist_half', 'waitlist_final'] as const) {
      const body = renderSequenceLeg(leg, waitlistInput);
      expect(smsEncoding(withOptOut(body))).toBe('gsm7');
      expect(smsSegments(withOptOut(body))).toBeLessThanOrEqual(MAX_NUDGE_SEGMENTS);
    }
  });

  it('names the deadline in the family’s own clock', () => {
    // 03:00 UTC on 17 Sep is 23:00 on 16 Sep in Toronto.
    expect(renderSequenceLeg('waitlist_final', waitlistInput)).toContain('11:00 p.m.');
  });

  it('is honest that the clock runs from the parent’s own message', () => {
    // Hale never sees the municipality's offer email, so it may not claim to know
    // when the offer landed — only when it was told.
    expect(renderSequenceLeg('waitlist_half', waitlistInput).toLowerCase()).toContain(
      'from your message',
    );
  });

  it('names the municipality’s published response window, not a Hale default', () => {
    expect(renderSequenceLeg('waitlist_half', waitlistInput)).toContain('36h');
    expect(
      renderSequenceLeg('waitlist_half', {
        ...waitlistInput,
        shortlist: shortlist({ waitlistResponseHours: 48 }),
      }),
    ).toContain('48h');
  });
});

describe('renderCheckInReply', () => {
  const base = { shortlist: shortlist(), timeZone: TZ, now: NOW };

  it('celebrates a spot and says what was recorded', () => {
    const body = renderCheckInReply({ ...base, reply: { outcome: 'registered' } });
    expect(body).toContain('Richmond Hill');
    expect(smsEncoding(body)).toBe('gsm7');
    expect(smsSegments(body)).toBeLessThanOrEqual(MAX_NUDGE_SEGMENTS);
  });

  it('acknowledges a waitlist position and promises the clock it can actually keep', () => {
    const body = renderCheckInReply({
      ...base,
      reply: {
        outcome: 'waitlisted',
        position: 15,
        deadlineAt: new Date('2026-09-17T03:00:00.000Z'),
      },
    });
    expect(body).toContain('15');
    expect(body).toContain('36h');
  });

  it('says plainly that there is no clock where the municipality publishes none', () => {
    const body = renderCheckInReply({
      ...base,
      shortlist: shortlist({ waitlistResponseHours: null }),
      reply: { outcome: 'waitlisted', position: 15, deadlineAt: null },
    });
    expect(body.toLowerCase()).toContain('no published');
    expect(body).not.toContain('36h');
  });

  it('acknowledges a waitlist with no position number', () => {
    const body = renderCheckInReply({
      ...base,
      reply: {
        outcome: 'waitlisted',
        position: null,
        deadlineAt: new Date('2026-09-17T03:00:00.000Z'),
      },
    });
    expect(body).not.toContain('null');
    expect(body).not.toContain('#');
  });

  it('answers a missed window without a silver lining nobody asked for', () => {
    const body = renderCheckInReply({ ...base, reply: { outcome: 'missed' } });
    expect(smsEncoding(body)).toBe('gsm7');
    expect(smsSegments(body)).toBeLessThanOrEqual(MAX_NUDGE_SEGMENTS);
  });

  it('re-asks once, repeating the three answers it can read', () => {
    const body = renderCheckInReply({ ...base, reply: { outcome: null } });
    expect(body.toLowerCase()).toContain('got in');
    expect(body.toLowerCase()).toContain('waitlisted');
    expect(body.toLowerCase()).toContain('missed');
  });
});

describe('renderShortlistRationale', () => {
  it('states the window, the link and the per-child fit, and nothing else', () => {
    const text = renderShortlistRationale(shortlist(), TZ, NOW);
    expect(text).toContain('Richmond Hill');
    expect(text).toContain('Fall 2026');
    expect(text).toContain('recreation programs');
    expect(text).toContain(LONGEST_URL);
    expect(text).toContain('Max');
  });

  it('spells out the tolerance rather than asserting a band Hale cannot confirm', () => {
    const text = renderShortlistRationale(
      shortlist({ fitNotes: [{ childId: 'c1', name: 'Max', fit: 'near_band' }] }),
      TZ,
      NOW,
    );
    expect(text.toLowerCase()).toContain('just outside');
  });

  it('keeps a 13+ child nameless', () => {
    const text = renderShortlistRationale(
      shortlist({ fitNotes: [{ childId: 'c1', name: null, fit: 'in_band' }] }),
      TZ,
      NOW,
    );
    expect(text).toContain('Your teen');
    expect(text).not.toContain('null');
  });

  it('names the resident head start in days where the family has one', () => {
    const text = renderShortlistRationale(
      shortlist({ isResidentWindow: true, residentPriorityDays: 7 }),
      TZ,
      NOW,
    );
    expect(text).toContain('7 days');
  });
});
