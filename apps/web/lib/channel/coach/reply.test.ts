import { describe, expect, it, vi } from 'vitest';
import { SAFETY_REPLY } from '~/lib/channel/off-domain/copy';
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

    const out = toSmsReply(raw, { children: [], now: NOW });

    expect(out).toBe('Two swims this week: Mon 4:30 Thu 5:15 Which one?');
  });

  it('transliterates the characters that would flip the message to UCS-2', () => {
    const raw = 'Move swim to Tue 4:30 — it’s free then. YES to confirm.';

    const out = toSmsReply(raw, { children: [], now: NOW });

    expect(out).toBe("Move swim to Tue 4:30 - it's free then. YES to confirm.");
    expect(smsSegments(out)).toBe(1);
  });

  it('redacts a teen name before the body ever reaches the carrier', () => {
    const out = toSmsReply('Nora has practice Thursday.', {
      children: [TEEN],
      now: NOW,
    });

    expect(out).toBe('your kid has practice Thursday.');
  });

  it('leaves a reply already inside the budget untouched', () => {
    const raw = 'Move swim to Tue 4:30? YES to confirm.';

    expect(toSmsReply(raw, { children: [], now: NOW })).toBe(raw);
  });

  /**
   * The trim drops whole sentences from the END and stops there. It used to append
   * "More in the app: <url>", which fired precisely when the answer was too long to
   * send — the app-point on the message that mattered most (skill audit P0 #4). What
   * survives is the FIRST sentence, which is where the skill puts the answer, and what
   * the trim must never do is exceed the budget it exists to enforce.
   */
  it('trims an over-budget reply to whole sentences, and points nowhere', () => {
    const raw = [
      'Swim is on Tuesday at four thirty and Thursday at five fifteen this week.',
      'The Thursday one is at the east pool rather than the usual west pool.',
      'There is also a make-up class on Saturday morning if you would rather do that.',
      'Registration for the fall session opens on the fifteenth of next month.',
      'I can draft any of those changes for you to approve whenever you are ready.',
    ].join(' ');

    const out = toSmsReply(raw, { children: [], now: NOW });

    expect(smsSegments(raw)).toBeGreaterThan(MAX_REPLY_SEGMENTS);
    expect(smsSegments(out)).toBeLessThanOrEqual(MAX_REPLY_SEGMENTS);
    expect(out).not.toContain(LINK);
    expect(out).not.toMatch(/\bthe app\b/i);
    expect(out.startsWith('Swim is on Tuesday')).toBe(true);
    // Whole sentences only — the trim never lands mid-word.
    expect(out).not.toMatch(/\w\.\.\.\s/);
  });

  it('trims a single unbroken over-budget sentence on a word boundary', () => {
    const raw = `${'swim '.repeat(80)}now`;

    const out = toSmsReply(raw, { children: [], now: NOW });

    expect(smsSegments(out)).toBeLessThanOrEqual(MAX_REPLY_SEGMENTS);
    expect(out).not.toContain(LINK);
    expect(out.endsWith('...')).toBe(true);
    expect(out).not.toMatch(/swi\b/);
  });

  /** No prefix of a single 300-character token fits, so there is nothing honest left to
   * send. The router reads the throw as a failed turn and answers with its own template
   * — the same outcome an empty body gets, and the right one. */
  it('refuses a body with no prefix inside the budget', () => {
    expect(() => toSmsReply('x'.repeat(400), { children: [], now: NOW })).toThrow(/budget/i);
  });

  it('refuses to emit an empty body', () => {
    expect(() => toSmsReply('   \n  ', { children: [], now: NOW })).toThrow(/empty/i);
  });
});

/**
 * Skill audit P0 #3 — the siren, on the path that fires when the screen breaks.
 *
 * The off-domain screen FAILS OPEN by design (screen.ts openTheGate), so on a missing
 * key, a skill-load failure or a provider outage a "she hit her head and won't stop
 * crying" walks straight past the fixed 811/911 line and into the coach, whose skill
 * then asks it for a siren of its own — one that historically named a doctor and no
 * number at all. A prompt cannot be the guarantee here. This is.
 *
 * Strict equality against the constant, never a regex: "mentions 811" is what the
 * improvised version already did. What a parent standing over a hurt child gets has to
 * be the reviewed sentence, whole, including the 911 the improvisation drops.
 */
describe('the fixed safety reply is the only siren that leaves the coach', () => {
  const send = (raw: string) => toSmsReply(raw, { children: [], now: NOW });

  it.each([
    ['a referral naming only the health line', 'Sounds rough - call 811 if it gets worse.'],
    ['a referral naming only emergency', 'If she is struggling to breathe, call 911 now.'],
    ['a referral wrapped in advice', 'Most bumps are fine. Watch her, and 811 can advise.'],
    ['a referral buried in a scheduling answer', 'Swim is Tuesday. Ring 811 about the rash.'],
  ])('replaces %s with the fixed line, verbatim', (_name, raw) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(send(raw)).toBe(SAFETY_REPLY);
  });

  it('is idempotent — the fixed line survives its own guard unchanged', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(send(SAFETY_REPLY)).toBe(SAFETY_REPLY);
  });

  it('says out loud that it fired, so an improvised siren is countable', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    send('Call 811 about that one.');

    expect(logged).toHaveBeenCalledTimes(1);
  });

  /** The trigger is the two numbers as whole tokens, so an ordinary week does not trip
   * it: a clock time and a phone number both carry those digits inside something else. */
  it.each([
    'Swim moved to Thursday at 9:11 and I have told the coach.',
    'The number they gave me is 647-555-0811, want me to save it?',
  ])('leaves an ordinary reply alone: %s', (raw) => {
    expect(send(raw)).toBe(raw);
  });
});
