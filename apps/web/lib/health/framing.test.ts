import { describe, expect, it } from 'vitest';
import { smsEncoding, smsSegments } from '~/lib/channel/sms-segments';
import { NUDGE_OPT_OUT } from '~/lib/channel/nudge/nudge-voice';
import {
  HEALTH_CHECKPOINTS,
  MAX_LINK_URL_LENGTH,
  TEEN_STAGE_MIN_MONTHS,
} from './checkpoints';
import { HEALTH_CLOSE, HEALTH_CLOSE_BOOKING, renderHealthNudge } from './copy';
import { HEALTH_BANNED_PHRASES, findBannedPhrases } from './framing';
import { AGE_TOLERANCE_MONTHS } from '~/lib/registration/match-registration-windows';

/**
 * VIL-243 · M8 — THE CONTENT REVIEW GATE.
 *
 * Health-admin copy is the one place in Hale where a sentence that reads fine can do
 * real harm: a parent told their child is "behind" on vaccines hears a diagnosis Hale
 * has no standing to make and no data to support. So every string this feature can
 * ever put in front of a parent is linted here, and the lint runs over the RENDERED
 * message — not just the source strings — because a template can assemble a banned
 * phrase out of two innocent halves.
 */

/** A stand-in family for rendering: two named under-13s, so the plural subject path
 * and the longest realistic name run through the lint too. */
const KID_NAMES = ['Genevieve', 'Maximilian'];

function everyRenderedMessage(): Array<{ id: string; variant: string; body: string }> {
  const rendered: Array<{ id: string; variant: string; body: string }> = [];
  for (const checkpoint of HEALTH_CHECKPOINTS) {
    rendered.push({
      id: checkpoint.id,
      variant: 'named',
      body: renderHealthNudge({
        kind: 'health_checkpoint',
        checkpointRef: { id: checkpoint.id, region: checkpoint.region },
        ref: `${checkpoint.id}:child-1:0`,
        kidNames: KID_NAMES,
        teenOnly: false,
        teenCount: 0,
      }),
    });
    rendered.push({
      id: checkpoint.id,
      variant: 'unnamed',
      body: renderHealthNudge({
        kind: 'health_checkpoint',
        checkpointRef: { id: checkpoint.id, region: checkpoint.region },
        ref: `${checkpoint.id}:child-1:0`,
        kidNames: [],
        teenOnly: false,
        teenCount: 0,
      }),
    });
    if (checkpoint.teenSafeTask !== null) {
      rendered.push({
        id: checkpoint.id,
        variant: 'teen',
        body: renderHealthNudge({
          kind: 'health_checkpoint',
          checkpointRef: { id: checkpoint.id, region: checkpoint.region },
          ref: `${checkpoint.id}:child-1:0`,
          kidNames: [],
          teenOnly: true,
          teenCount: 2,
        }),
      });
    }
  }
  return rendered;
}

describe('findBannedPhrases', () => {
  it('catches the judgment vocabulary this feature exists to avoid', () => {
    expect(findBannedPhrases('Maya is behind on her shots')).toContain('behind');
    expect(findBannedPhrases('This visit is overdue')).toContain('overdue');
    expect(findBannedPhrases('She should already be walking')).toContain('should already');
    expect(findBannedPhrases('a milestone was missed')).toContain('missed');
    expect(findBannedPhrases('possible developmental delay')).toContain('delay');
  });

  it('catches diagnosis-adjacent words even in friendly sentences', () => {
    expect(findBannedPhrases('Nothing to diagnose here, promise')).toContain('diagnose');
    expect(findBannedPhrases('watch for symptoms')).toContain('symptoms');
    expect(findBannedPhrases('perfectly normal for her age')).toContain('normal');
  });

  it('catches second-person pressure, so copy stays an offer', () => {
    expect(findBannedPhrases('You must report this')).toContain('you must');
    expect(findBannedPhrases('Make sure you file it')).toContain('make sure');
    expect(findBannedPhrases("Don't forget the form")).toContain("don't forget");
  });

  /**
   * The cases a literal-string lint waves through. Every one is copy a careful author
   * could plausibly write, which is exactly why the gate has to survive inflection and
   * paraphrase rather than exact spelling.
   */
  it('survives inflection — plurals, participles, adverbs, hyphens', () => {
    const slips = [
      'delays are common',
      'lateness happens',
      'a catch-up clinic',
      'catching up on records',
      'at-risk families',
      'risky for her',
      'diagnosing anything',
      'symptomatic children',
      'other conditions',
      'diseases and disorders',
      'suspensions are issued',
      'penalties may apply',
      'urgently, please',
      'immediate action',
      'abnormalities noted',
    ];
    for (const text of slips) {
      expect({ text, banned: findBannedPhrases(text).length > 0 }).toEqual({ text, banned: true });
    }
  });

  it('survives paraphrase of the second-person instruction', () => {
    const slips = [
      'you will need to report this',
      "you'll need to file it",
      'you really should report it',
      'be sure that you file it',
    ];
    for (const text of slips) {
      expect({ text, banned: findBannedPhrases(text).length > 0 }).toEqual({ text, banned: true });
    }
  });

  it('is word-bounded, so a legitimate word is not a false positive', () => {
    // 'immunization' contains 'immune'; 'lateral' and 'later' contain 'late';
    // 'commission' contains 'miss'; 'check-up' is not 'catch up'.
    for (const text of [
      'immunization record',
      'a lateral move',
      'later this month',
      'school commission',
      'a dental check-up',
      'with your family doctor',
    ]) {
      expect({ text, banned: findBannedPhrases(text) }).toEqual({ text, banned: [] });
    }
  });

  it('is case-insensitive, and reports what actually matched', () => {
    expect(findBannedPhrases('BEHIND')).toContain('behind');
    expect(findBannedPhrases('several DELAYS')).toContain('delays');
  });

  it('says nothing about copy that is purely administrative', () => {
    expect(
      findBannedPhrases('Ontario schedules a routine vaccine visit at 6 months.'),
    ).toEqual([]);
  });
});

describe('the shipped health content', () => {
  it('has a gate wide enough to be worth running (the lint is not vacuous)', () => {
    expect(HEALTH_BANNED_PHRASES.length).toBeGreaterThan(20);
  });

  it('carries no banned phrase in any rendered message', () => {
    for (const { id, variant, body } of everyRenderedMessage()) {
      expect({ id, variant, banned: findBannedPhrases(body) }).toEqual({
        id,
        variant,
        banned: [],
      });
    }
  });

  it('carries no banned phrase in the shared closes', () => {
    expect(findBannedPhrases(HEALTH_CLOSE)).toEqual([]);
    expect(findBannedPhrases(HEALTH_CLOSE_BOOKING)).toEqual([]);
  });

  it('ends every message with the ONE reply-able close', () => {
    for (const { id, variant, body } of everyRenderedMessage()) {
      const checkpoint = HEALTH_CHECKPOINTS.find((c) => c.id === id);
      const close = checkpoint?.booking ? HEALTH_CLOSE_BOOKING : HEALTH_CLOSE;
      expect({ id, variant, ends: body.endsWith(close) }).toEqual({
        id,
        variant,
        ends: true,
      });
    }
  });

  it('fits two SMS segments once the CASL opt-out is appended', () => {
    for (const { id, variant, body } of everyRenderedMessage()) {
      const segments = smsSegments(`${body}\n\n${NUDGE_OPT_OUT}`);
      expect({ id, variant, segments: segments <= 2 }).toEqual({
        id,
        variant,
        segments: true,
      });
    }
  });

  it('stays inside GSM-7, so one curly quote never halves the budget', () => {
    for (const { id, variant, body } of everyRenderedMessage()) {
      expect({ id, variant, encoding: smsEncoding(body) }).toEqual({
        id,
        variant,
        encoding: 'gsm7',
      });
    }
  });
});

describe('the checkpoint table', () => {
  it('covers the Ontario schedule ages the ticket names', () => {
    const covers = (months: number) =>
      HEALTH_CHECKPOINTS.some(
        (c) =>
          c.region === 'ontario' &&
          c.id.startsWith('immunization_') &&
          months >= c.minMonths &&
          months <= c.maxMonths,
      );
    // 2, 4, 6, 12, 15, 18 months; the 4-6 year booster; grade 7; 14-16 years.
    for (const months of [2, 4, 6, 12, 15, 18, 54, 144, 174]) {
      expect({ months, covered: covers(months) }).toEqual({ months, covered: true });
    }
  });

  it('names an official source and a short in-message link for every row', () => {
    for (const checkpoint of HEALTH_CHECKPOINTS) {
      expect(checkpoint.sourceUrl).toMatch(
        /^https:\/\/(www\.ontario\.ca|www\.toronto\.ca|tph\.icon\.ehealthontario\.ca)\//,
      );
      expect(checkpoint.linkUrl).toMatch(
        /^https:\/\/(www\.ontario\.ca|www\.toronto\.ca|tph\.icon\.ehealthontario\.ca)\//,
      );
      expect({ id: checkpoint.id, len: checkpoint.linkUrl.length <= MAX_LINK_URL_LENGTH }).toEqual(
        { id: checkpoint.id, len: true },
      );
    }
  });

  it('links the ICON self-report portal from the Toronto records checkpoint', () => {
    const icon = HEALTH_CHECKPOINTS.find((c) => c.region === 'toronto');
    expect(icon?.linkUrl).toBe('https://tph.icon.ehealthontario.ca/#!/welcome');
  });

  it('has unique ids and age-ordered, non-inverted bands', () => {
    const ids = HEALTH_CHECKPOINTS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const checkpoint of HEALTH_CHECKPOINTS) {
      expect({ id: checkpoint.id, ok: checkpoint.minMonths <= checkpoint.maxMonths }).toEqual({
        id: checkpoint.id,
        ok: true,
      });
    }
  });

  it('gives every teen-reachable checkpoint a generic, teen-safe task (rule #1)', () => {
    for (const checkpoint of HEALTH_CHECKPOINTS) {
      const reachesTeens = checkpoint.maxMonths + AGE_TOLERANCE_MONTHS >= TEEN_STAGE_MIN_MONTHS;
      if (!reachesTeens) continue;
      expect({ id: checkpoint.id, teenSafe: typeof checkpoint.teenSafeTask }).toEqual({
        id: checkpoint.id,
        teenSafe: 'string',
      });
    }
  });

  it('keeps every teen-safe task free of a vaccine or condition specific', () => {
    // The teen render may say WHAT KIND of paperwork it is and nothing else. A row that
    // named the vaccine would be surfacing a 13+ child's health content to a parent.
    for (const checkpoint of HEALTH_CHECKPOINTS) {
      if (checkpoint.teenSafeTask === null) continue;
      expect(checkpoint.teenSafeTask.toLowerCase()).not.toMatch(
        /\b(hpv|hepatitis|meningococcal|tetanus|measles|polio|dose|booster|shot)\b/,
      );
    }
  });
});
