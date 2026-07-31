import { describe, expect, it } from 'vitest';
import { smsSegments } from '~/lib/channel/sms-segments';
import { MAX_REPLY_SEGMENTS, redactTeenNames, toSmsReply } from './reply';

/**
 * The post-processing between the model and the carrier. Everything asserted here is a
 * BACKSTOP: the skill already asks for plain, short, ASCII prose. These tests pin what
 * happens when it doesn't get one — which is the only case that matters, because the
 * model is the one part of this path that cannot be made to behave by construction.
 */

const NOW = new Date('2026-07-30T12:00:00.000Z');
const LINK = 'https://app.villagehale.com';

/** DOBs derived from the @hale/types stage boundary (teenager ≥ 156 months), against
 * NOW rather than from any code output. */
const TEEN = { name: 'Nora', gender: 'girl', dateOfBirth: '2010-03-04' };
const TODDLER = { name: 'Milo', gender: 'boy', dateOfBirth: '2024-07-30' };

describe('redactTeenNames', () => {
  it("replaces a 13+ child's first name with the generic identifier", () => {
    const out = redactTeenNames("Nora's shift moved to Thursday.", [TEEN], NOW);

    expect(out).toBe("your kid's shift moved to Thursday.");
  });

  it('leaves a under-13 child named', () => {
    const out = redactTeenNames('Milo has swim on Tuesday.', [TODDLER], NOW);

    expect(out).toBe('Milo has swim on Tuesday.');
  });

  it('matches the name case-insensitively and only on word boundaries', () => {
    const out = redactTeenNames('nora is out. Noraville is a place.', [TEEN], NOW);

    expect(out).toBe('your kid is out. Noraville is a place.');
  });

  it('ages the gate live — a child 13 next month is still named today', () => {
    const almost = { name: 'Kit', gender: 'boy', dateOfBirth: '2013-08-30' };

    expect(redactTeenNames('Kit has practice.', [almost], NOW)).toBe('Kit has practice.');
  });
});

describe('toSmsReply', () => {
  it('strips markdown the phone would render literally', () => {
    const raw = '**Two swims** this week:\n\n- Mon 4:30\n- Thu 5:15\n\nWhich one?';

    const out = toSmsReply(raw, { children: [], appLink: LINK, now: NOW });

    expect(out).toBe('Two swims this week: Mon 4:30 Thu 5:15 Which one?');
  });

  it('transliterates the characters that would flip the message to UCS-2', () => {
    const raw = 'Move swim to Tue 4:30 — it’s free then. YES to confirm.';

    const out = toSmsReply(raw, { children: [], appLink: LINK, now: NOW });

    expect(out).toBe("Move swim to Tue 4:30 - it's free then. YES to confirm.");
    expect(smsSegments(out)).toBe(1);
  });

  it('redacts a teen name before the body ever reaches the carrier', () => {
    const out = toSmsReply('Nora has practice Thursday.', {
      children: [TEEN],
      appLink: LINK,
      now: NOW,
    });

    expect(out).toBe('your kid has practice Thursday.');
  });

  it('leaves a reply already inside the budget untouched', () => {
    const raw = 'Move swim to Tue 4:30? YES to confirm.';

    expect(toSmsReply(raw, { children: [], appLink: LINK, now: NOW })).toBe(raw);
  });

  /**
   * The trim drops whole sentences from the END and hands the parent the app instead
   * of a body cut mid-word. What it must never do is exceed the budget it exists to
   * enforce — a "trimmed" reply that is still three segments would be a bug that costs
   * money silently.
   */
  it('trims an over-budget reply to whole sentences plus the app link', () => {
    const raw = [
      'Swim is on Tuesday at four thirty and Thursday at five fifteen this week.',
      'The Thursday one is at the east pool rather than the usual west pool.',
      'There is also a make-up class on Saturday morning if you would rather do that.',
      'Registration for the fall session opens on the fifteenth of next month.',
      'I can draft any of those changes for you to approve whenever you are ready.',
    ].join(' ');

    const out = toSmsReply(raw, { children: [], appLink: LINK, now: NOW });

    expect(smsSegments(raw)).toBeGreaterThan(MAX_REPLY_SEGMENTS);
    expect(smsSegments(out)).toBeLessThanOrEqual(MAX_REPLY_SEGMENTS);
    expect(out).toContain(LINK);
    expect(out.startsWith('Swim is on Tuesday')).toBe(true);
    // Whole sentences only — the trim never lands mid-word.
    expect(out).not.toMatch(/\w\.\.\.\s/);
  });

  it('trims a single unbroken over-budget sentence on a word boundary', () => {
    const raw = `${'swim '.repeat(80)}now`;

    const out = toSmsReply(raw, { children: [], appLink: LINK, now: NOW });

    expect(smsSegments(out)).toBeLessThanOrEqual(MAX_REPLY_SEGMENTS);
    expect(out).toContain(LINK);
    expect(out).not.toMatch(/swi\b/);
  });

  it('refuses to emit an empty body', () => {
    expect(() => toSmsReply('   \n  ', { children: [], appLink: LINK, now: NOW })).toThrow(
      /empty/i,
    );
  });
});
