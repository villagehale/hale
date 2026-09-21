import { describe, expect, it } from 'vitest';
import type { LoopCategory, LoopMessage, RenderedContent } from '~/lib/channel/types';
import { smsSegments } from '~/lib/channel/sms-segments';
import type { ChildNameLevel } from '~/lib/loop/prefs';
import { loopTemplateRenderer } from '../registry';
import type { ReminderChild, ReminderEventView, ReminderPayload } from './payload';
import { foldReminderVoice } from './sms';

/**
 * VIL-223 · D1 — the reminder per-channel renderers, exercised through the registry
 * seam (loopTemplateRenderer.render(message, channel, nameLevel)). Every expectation
 * derives from the copy spec + the privacy rules (teen age gate, sensitive gate, the
 * no-link-on-T-1h rule, the SMS segment budget), never from observed output.
 */

const EM_DASH = '—';
const TZ = 'America/Toronto';
const DEEP_LINK = 'https://app.villagehale.com/plan';
const UNSUB = 'https://app.villagehale.com/unsubscribe?u=user-1&t=daily_digest&sig=abc';

const maya: ReminderChild = { id: 'c-maya', name: 'Maya', dateOfBirth: '2019-03-10', gender: 'girl' };
// 2011 DOB is ~15y → deriveStage 'teenager' → forced generic at every level/channel.
const teen: ReminderChild = { id: 'c-teen', name: 'Sam', dateOfBirth: '2011-01-01', gender: 'boy' };

function ev(over: Partial<ReminderEventView> = {}): ReminderEventView {
  return { eventRef: 'e1', title: 'Swim class', startsAt: '2026-07-25T20:30:00Z', childId: null, ...over };
}

// 14:00Z = 10:00 EDT, 20:30Z = 4:30 EDT (America/Toronto, summer).
const apptAt10 = ev({ eventRef: 'e-appt', childId: 'c-teen', title: 'Therapy', startsAt: '2026-07-25T14:00:00Z' });
const swimAt430 = ev({ eventRef: 'e-swim', childId: 'c-maya', title: 'Swim class', startsAt: '2026-07-25T20:30:00Z' });

function payload(over: Partial<ReminderPayload> = {}): ReminderPayload {
  return {
    offset: '-P1D',
    timeZone: TZ,
    events: [],
    children: [maya, teen],
    deepLink: DEEP_LINK,
    unsubscribeUrl: UNSUB,
    ...over,
  };
}

function msg(p: ReminderPayload, templateKey = 'reminder', category: LoopCategory = 'reminder'): LoopMessage {
  return {
    templateKey,
    familyId: 'fam-1',
    parentUserId: 'user-1',
    category,
    urgency: p.offset === '-PT1H' ? 'time_sensitive' : 'normal',
    payload: p as unknown as Record<string, unknown>,
  };
}

function render(p: ReminderPayload, channel: 'email' | 'sms', level: ChildNameLevel): RenderedContent {
  return loopTemplateRenderer.render(msg(p), channel, level);
}

function sms(p: ReminderPayload, level: ChildNameLevel): string {
  const r = render(p, 'sms', level);
  if (r.kind !== 'sms') throw new Error('expected sms');
  return r.text;
}

function email(p: ReminderPayload, level: ChildNameLevel) {
  const r = render(p, 'email', level);
  if (r.kind !== 'email') throw new Error('expected email');
  return r;
}

const batch = payload({ offset: '-P1D', events: [apptAt10, swimAt430] });
const single = payload({ offset: '-PT1H', events: [swimAt430], deepLink: null });

/**
 * The lead is POOLED — three ways of saying each distance, rotating once per the event's
 * own family-local day, because a family with something on every day reads this string
 * every single day. The EMAIL subject keeps the unpooled first member: a subject line that
 * varied per day would make a reminder thread unrecognisable in a mailbox.
 *
 * Restated here rather than imported, deliberately: these words are the spec, and a copy
 * change to them should be a diff a reviewer reads in two places.
 */
const TOMORROW_LEADS = /^(?:Tomorrow|Coming up tomorrow|On for tomorrow): /;
const HOUR_LEADS = /^(?:In an hour|An hour from now|Just about an hour away): /;

describe('T-24h batch — Tomorrow lead, every event listed', () => {
  it('sms folds to GSM-7 (em-dash → hyphen), one segment, no link (fits the budget)', () => {
    const text = sms(batch, 'first_name');
    expect(text).toMatch(TOMORROW_LEADS);
    expect(text.replace(TOMORROW_LEADS, '')).toBe(
      'an appointment at 10:00, Maya - Swim class at 4:30',
    );
    expect(smsSegments(text)).toBe(1);
    expect(text).not.toContain('http');
  });

  it('email lists both events as a time→event note and carries the See-your-week link', () => {
    const e = email(batch, 'first_name');
    expect(e.subject).toBe(`Tomorrow: an appointment at 10:00, Maya ${EM_DASH} Swim class at 4:30`);
    expect(e.html).toContain('Swim class');
    expect(e.html).toContain('an appointment');
    // Both times are surfaced in the note body (the batch tabular list).
    expect(e.html).toContain('4:30');
    expect(e.html).toContain('10:00');
    expect(e.html).toContain(`href="${DEEP_LINK}"`);
    expect(e.html).toContain('See your week');
  });
});

describe('T-1h single — In an hour lead, glanceable, no links anywhere (rule #6)', () => {
  it('sms is one segment and carries no url', () => {
    const text = sms(single, 'first_name');
    expect(text).toMatch(HOUR_LEADS);
    expect(text.replace(HOUR_LEADS, '')).toBe('Maya - Swim class at 4:30');
    expect(smsSegments(text)).toBe(1);
    expect(text).not.toContain('http');
  });

  it('email has no See-your-week link and no /plan link (glanceable, rule #6)', () => {
    const e = email(single, 'first_name');
    expect(e.subject).toBe(`In an hour: Maya ${EM_DASH} Swim class at 4:30`);
    expect(e.html).not.toContain('See your week');
    expect(e.html).not.toContain('/plan');
  });
});

describe('teen event is generic at EVERY level and EVERY channel (rule #1)', () => {
  const teenBatch = payload({ offset: '-P1D', events: [apptAt10] });
  const teenPing = payload({ offset: '-PT1H', events: [apptAt10], deepLink: null });

  it('never surfaces the teen name or the title — only "an appointment"', () => {
    for (const level of ['first_name', 'relation', 'generic'] as ChildNameLevel[]) {
      for (const p of [teenBatch, teenPing]) {
        const smsText = sms(p, level);
        const html = email(p, level).html;
        for (const out of [smsText, html]) {
          expect(out).toContain('an appointment');
          expect(out).not.toContain('Sam');
          expect(out).not.toContain('Therapy');
        }
      }
    }
  });
});

describe('a flagged-sensitive event is generic even for a non-teen (rule #1)', () => {
  const sensitive = ev({ childId: 'c-maya', title: 'Blood test', sensitive: true });
  const p = payload({ offset: '-P1D', events: [sensitive] });

  it('shows "an appointment", never the health title, on every channel', () => {
    for (const out of [sms(p, 'first_name'), email(p, 'first_name').html]) {
      expect(out).toContain('an appointment');
      expect(out).not.toContain('Blood test');
    }
  });
});

describe('SMS segment budget', () => {
  it('a single T-1h reminder is exactly one segment', () => {
    expect(smsSegments(sms(single, 'first_name'))).toBe(1);
  });

  /** family_events titles are freeform — a parent types what they like — so the ceiling
   * cannot depend on every line being short. Dropping whole lines cannot rescue a batch
   * of one, which is exactly where the cap used to be abandoned. */
  const longTitle =
    'Parent teacher interview about the spring reading assessment and the summer enrichment options, whether we should move up a reading level before September, and the paperwork the office needs back before the end of the month with the forms from the specialist attached to it and a note about the bus route';

  it('trims the line itself when ONE event is longer than the ceiling', () => {
    const p = payload({ offset: '-PT1H', deepLink: null, events: [ev({ title: longTitle })] });
    const text = sms(p, 'first_name');

    expect(smsSegments(text)).toBeLessThanOrEqual(2);
    expect(text).toMatch(HOUR_LEADS);
    expect(text.replace(HOUR_LEADS, '').startsWith('Parent teacher interview')).toBe(true);
    expect(text.endsWith('...')).toBe(true); // says it was cut rather than just stopping
    expect(text).not.toContain('http'); // rule #6 — no link on the T-1h ping
  });

  it('holds the ceiling when the first line of a batch is the over-long one', () => {
    const text = sms(payload({ events: [ev({ title: longTitle }), swimAt430] }), 'first_name');

    expect(smsSegments(text)).toBeLessThanOrEqual(2);
    expect(text).toContain('+1 more');
    expect(text).toContain(DEEP_LINK);
  });

  it('a large batch caps the inline list to "+N more" plus the /plan link, ≤2 segments', () => {
    const many = payload({
      offset: '-P1D',
      events: Array.from({ length: 20 }, (_, i) => ev({ eventRef: `e-${i}`, title: 'Swim class' })),
    });
    const text = sms(many, 'first_name');
    expect(smsSegments(text)).toBeLessThanOrEqual(2);
    expect(text).toMatch(/\+\d+ more/);
    expect(text).toContain(DEEP_LINK);
  });
});

describe('email fail-closed CASL', () => {
  it('throws when the unsubscribe url is missing', () => {
    expect(() => email(payload({ offset: '-P1D', events: [swimAt430], unsubscribeUrl: null }), 'first_name')).toThrow(
      /unsubscribe/,
    );
  });

  it('carries the sender identity, business address, and the escaped unsubscribe url', () => {
    const e = email(batch, 'first_name');
    expect(e.html).toContain('Village Hale Technologies Inc.');
    expect(e.html).toContain('https://app.villagehale.com/unsubscribe?u=user-1&amp;t=daily_digest&amp;sig=abc');
  });
});

describe('VIL-229 voice slot — email-only serif signature, deterministic fallback', () => {
  const VOICE = "Tomorrow's the big swim day for Maya";

  it('single: the voice line is the serif signature, replacing the deterministic descriptor', () => {
    const e = email(payload({ offset: '-P1D', events: [swimAt430], voice: { line: VOICE } }), 'first_name');
    expect(e.html).toContain(VOICE);
    // Replaces the deterministic serif line…
    expect(e.html).not.toContain(`Maya ${EM_DASH} Swim class`);
    // …but the TIME stays slot-injected (never in the voice string).
    expect(e.html).toContain('4:30');
  });

  it('batch: the voice opens as a serif lead; the per-event facts stay in the list', () => {
    const e = email(payload({ offset: '-P1D', events: [apptAt10, swimAt430], voice: { line: VOICE } }), 'first_name');
    expect(e.html).toContain(VOICE);
    expect(e.html).toContain('Swim class'); // list keeps the descriptor facts
    expect(e.html).toContain('10:00');
  });

  it('falls back to the deterministic line when the voice is absent (rule #8 fail-open)', () => {
    const e = email(payload({ offset: '-PT1H', events: [swimAt430], deepLink: null }), 'first_name');
    expect(e.html).toContain(`Maya ${EM_DASH} Swim class`);
  });

  /**
   * VIL-353/v5: the SMS no longer ignores it. payload.ts called this field "email-only"
   * and the renderer simply did not read it — the composition had already happened, at no
   * extra cost, and a human sentence was being thrown away on the surface a parent
   * actually reads. It now rides, behind a fold measured at ONE segment.
   *
   * THE FOUR CONDITIONS ARE THE TEST (docs/voice.md, "The two SMS folds"), and every
   * fixture below is hand-written against one of them rather than copied from a model: a
   * sentence the wire would silently eat, a sentence that asks, a body that has lost its
   * offset, and a sentence too long for the glance. Each refusal carries its own NAME out
   * of the renderer, because "the composer degraded" and "the composer wrote something we
   * would not send" are different bugs in different places (rule #11).
   */
  const BODY = 'Tomorrow: Maya - Swim class at 4:30';

  function smsVoice(p: ReminderPayload): { text: string; voice: unknown } {
    const r = render(p, 'sms', 'first_name');
    if (r.kind !== 'sms') throw new Error('expected sms');
    return { text: r.text, voice: r.voice };
  }

  it('SMS carries the composed line when it fits inside the glance, and says so', () => {
    const p = payload({ offset: '-P1D', events: [swimAt430], voice: { line: VOICE } });
    const { text, voice } = smsVoice(p);
    expect(text).toContain(VOICE);
    expect(smsSegments(text)).toBe(1);
    // The facts stay slot-injected and keep their place ahead of it.
    expect(text).toMatch(TOMORROW_LEADS);
    expect(text).toContain('Swim class at 4:30');
    // THE OUTCOME LEAVES THE RENDERER. A caller that had to substring-match the body for
    // a sentence it did not choose would be guessing at its own renderer.
    expect(voice).toBe('used');
    expect(foldReminderVoice(BODY, VOICE).outcome).toBe('used');
  });

  it('refuses a line the wire would eat, rather than sending it a word short', () => {
    // gsmSafe maps a genuinely unmappable character to NOTHING (weekly-plan/core.ts), so
    // an emoji does not fail the render — it deletes, and the sentence arrives a word
    // short with no counter moving. Byte identity is the only check that sees a deletion.
    const eaten = 'Have a great one \u{1F389} see you there';
    const { text, voice } = smsVoice(
      payload({ offset: '-P1D', events: [swimAt430], voice: { line: eaten } }),
    );
    expect(voice).toBe('refused:gsm_dropped');
    expect(text).not.toContain('see you there');
    expect(foldReminderVoice(BODY, eaten).outcome).toBe('refused:gsm_dropped');
    // Positive control on the same path: the same sentence without the character ships.
    expect(foldReminderVoice(BODY, 'Have a great one, see you there').outcome).toBe('used');
  });

  it('refuses a line that ASKS — a reminder states a fact and owns no answer', () => {
    // A question appended to a reminder invites a bare YES, and a bare YES is claimed
    // family-wide by the approvals resolver (docs/voice.md rule 11). The slot's budget is
    // therefore ZERO questions, not one: there is no ask here for an answer to belong to.
    const asks = 'Ready? Towel packed?';
    const { text, voice } = smsVoice(
      payload({ offset: '-P1D', events: [swimAt430], voice: { line: asks } }),
    );
    expect(voice).toBe('refused:question_count');
    expect(text).not.toContain('?');
    expect(foldReminderVoice(BODY, asks).outcome).toBe('refused:question_count');
    // One is no better than two here, and that is the part a "at most one" rule misses.
    expect(foldReminderVoice(BODY, 'Towel packed?').outcome).toBe('refused:question_count');
  });

  it('keeps the offset in front of the voice, because the offset IS the message', () => {
    // whenLead is the FACT — "Tomorrow" / "In an hour" — and voice.line is composed by a
    // skill that says nothing about it (reminder-voice.md). The voice rides AFTER the
    // deterministic body, never instead of it.
    //
    // THE FOLD CANNOT LOSE THE LEAD, AND THAT IS WHY THERE IS NO CHECK FOR IT. It appends
    // to the rendered body, which already opens with the lead, so "the offset went
    // missing" is not a state this code has — the check that used to sit here compared the
    // function's own concatenation against its own prefix and could only fail if a test
    // called it with a lead the body never had. The property is real, so it is asserted
    // HERE, on the wire, where a renderer that started sending the voice instead of the
    // body would be caught.
    const { text, voice } = smsVoice(
      payload({
        offset: '-PT1H',
        events: [swimAt430],
        deepLink: null,
        voice: { line: 'Towel by the door.' },
      }),
    );
    expect(text).toMatch(HOUR_LEADS);
    expect(text.indexOf('Towel by the door.')).toBeGreaterThan(text.search(HOUR_LEADS));
    expect(text).toContain('Swim class at 4:30');
    expect(voice).toBe('used');
    expect(foldReminderVoice(BODY, 'Towel by the door.').text).toBe(`${BODY} Towel by the door.`);
  });

  it('gives up the VOICE rather than the glance, and says which happened', () => {
    // THE FOLD IS ONE SEGMENT, not the two-segment ceiling: a reminder is a glance, and a
    // human sentence is not worth doubling the message for. "No voice was composed" and
    // "a voice was composed and refused" are different facts about the voice stage, so
    // the fold returns which, and the renderer carries it out.
    const wordy = `${VOICE} and there is a whole paragraph of it after that, easily enough to push this reminder past the one segment it promises to fit inside`;
    const over = smsVoice(payload({ offset: '-P1D', events: [swimAt430], voice: { line: wordy } }));
    expect(over.text).not.toContain(wordy);
    expect(smsSegments(over.text)).toBe(1);
    expect(over.voice).toBe('refused:over_segment');
    expect(foldReminderVoice(BODY, wordy).outcome).toBe('refused:over_segment');

    const none = smsVoice(payload({ offset: '-P1D', events: [swimAt430] }));
    expect(none.voice).toBe('absent');
    expect(foldReminderVoice(BODY, null).outcome).toBe('absent');
  });

  it('names the outcome on the OVERFLOW path too, where the facts alone took the glance', () => {
    // A week-night with six things on it is over one segment before the voice is even
    // considered, and the overflow paths own the two-segment ceiling. That is still a
    // composed sentence that did not ship, and folding it into the same silence as
    // "nothing was composed" is exactly what the outcome exists to stop.
    const many = ['09:00', '11:00', '13:00', '15:00', '17:00', '19:00'].map((hhmm, n) =>
      ev({
        eventRef: `e-${n}`,
        childId: 'c-maya',
        title: `Swim class number ${n} at the community centre`,
        startsAt: `2026-07-25T${hhmm}:00Z`,
      }),
    );
    const crowded = payload({ offset: '-P1D', events: many, voice: { line: VOICE } });
    const over = smsVoice(crowded);
    expect(smsSegments(over.text)).toBeGreaterThan(1);
    expect(over.text).not.toContain(VOICE);
    expect(over.voice).toBe('refused:over_segment');
    // The same crowded night with nothing composed is 'absent', not a refusal.
    expect(smsVoice(payload({ offset: '-P1D', events: many })).voice).toBe('absent');
  });

  it('reads a different lead on a different day, and never a different fact', () => {
    // The pool exists because a family with something on every day reads this string every
    // single day. The occasion is the EVENT's own local day, not the render clock, so the
    // same reminder does not change wording depending on when the job happened to run.
    const days = ['2026-07-25', '2026-07-26', '2026-07-27', '2026-07-28'].map(
      (day) =>
        sms(
          payload({
            offset: '-P1D',
            events: [ev({ title: 'Swim class', startsAt: `${day}T20:30:00Z` })],
          }),
          'first_name',
        ).split(':')[0] as string,
    );
    for (let i = 1; i < days.length; i++) {
      expect(days[i], `day ${i}`).not.toBe(days[i - 1]);
    }
    // Every member names the same distance in time — the fact never moves.
    for (const lead of days) expect(lead.toLowerCase(), lead).toContain('tomorrow');
  });
});

describe('registry routing by templateKey', () => {
  it('routes a reminder message to the reminder renderer', () => {
    const r = loopTemplateRenderer.render(msg(batch), 'sms', 'first_name');
    expect(r.kind === 'sms' && TOMORROW_LEADS.test(r.text)).toBe(true);
  });

  it('still routes a weekly_plan message to its own renderer (not the reminder one)', () => {
    const weekly: LoopMessage = {
      templateKey: 'weekly_plan',
      familyId: 'fam-1',
      parentUserId: 'user-1',
      category: 'weekly_plan',
      urgency: 'normal',
      payload: {
        weekStart: '2026-07-20',
        summary: null,
        items: [],
        children: [],
        deepLink: DEEP_LINK,
        unsubscribeUrl: UNSUB,
      },
    };
    const r = loopTemplateRenderer.render(weekly, 'email', 'generic');
    expect(r.kind === 'email' && r.subject).toBe('Your week ahead');
  });
});
