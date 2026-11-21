import { describe, expect, it } from 'vitest';
import { smsEncoding } from '~/lib/channel/sms-segments';
import {
  OPT_OUT_LINE,
  OPT_OUT_LINE_CHARS,
  OPT_OUT_PERIOD_DAYS,
  OPT_OUT_SHORT,
  namesOptOutKeyword,
  optOutPeriodStart,
  segmentsWithOptOutReserved,
  withOptOut,
  writesOptOutLine,
} from './opt-out';

/**
 * Outbound texts do not carry an opt-out footer (founder decision, 2026-10-01).
 * Inbound STOP is a different path: the opt-out reader reads it (#868).
 */

describe('withOptOut', () => {
  it('returns the body unchanged for both forms', () => {
    for (const form of ['full', 'short'] as const) {
      expect(withOptOut('Swim moved to Tuesday.', form), form).toBe('Swim moved to Tuesday.');
    }
  });

  it('does not append either opt-out line', () => {
    for (const form of ['full', 'short'] as const) {
      const body = withOptOut('Body.', form);
      expect(body, form).toBe('Body.');
      expect(body, form).not.toContain(OPT_OUT_LINE);
      expect(body, form).not.toContain(OPT_OUT_SHORT);
    }
  });

  it('still names STOP as the keyword the intake machine answers', () => {
    // The footer is gone. Both strings stay the ones a composer must not write; a
    // parent's stop, in any wording, is read by the opt-out reader (#868).
    for (const line of [OPT_OUT_LINE, OPT_OUT_SHORT]) {
      expect(line, line).toContain('STOP');
    }
  });

  it('keeps both lines in GSM-7, so quoting one cannot double a segment', () => {
    expect(smsEncoding(OPT_OUT_LINE)).toBe('gsm7');
    expect(smsEncoding(OPT_OUT_SHORT)).toBe('gsm7');
  });
});

describe('optOutPeriodStart', () => {
  it('is an epoch-anchored grid, so every recipient agrees on the boundary unstored', () => {
    const a = new Date('2026-07-15T18:00:00.000Z');
    const b = new Date('2026-07-16T04:00:00.000Z');
    expect(optOutPeriodStart(a)).toEqual(optOutPeriodStart(b));
    expect(optOutPeriodStart(a).getTime() % (OPT_OUT_PERIOD_DAYS * 24 * 3_600_000)).toBe(0);
  });

  it('moves to a new period within the period length', () => {
    const start = optOutPeriodStart(new Date('2026-07-15T18:00:00.000Z'));
    const later = new Date(start.getTime() + OPT_OUT_PERIOD_DAYS * 24 * 3_600_000);
    expect(optOutPeriodStart(later).getTime()).toBeGreaterThan(start.getTime());
  });
});

describe("VIL-706 · reading Hale's own draft for an opt-out keyword", () => {
  it.each([
    ['STOP', 'Reply STOP anytime.'],
    ['STOP', 'STOP.'],
    ['HELP', 'Text HELP for help.'],
    ['AIDE', 'Besoin? (AIDE)'],
    ['ARRET', 'Répondez ARRÊT pour arrêter.'],
    ['ARRET', 'Écrivez ARRET.'],
  ])('names %s when it is written as a keyword', (keyword, text) => {
    expect(namesOptOutKeyword(text)).toBe(keyword);
  });

  it.each([
    ['STOP', 'Reply stop anytime and I will leave you alone.'],
    ['STOP', 'You can text Stop anytime.'],
    ['STOP', 'Just text "stop" whenever you want out.'],
    ['HELP', 'Text help if you need me.'],
    ['ARRET', 'Répondez Arrêt pour ne plus recevoir de messages.'],
    ['STOP', 'Just reply back with the word stop.'],
    ['STOP', 'Text me \u201cstop\u201d anytime.'],
    ['STOP', 'Any time, just say stop.'],
    ['STOP', 'You can opt out by replying stop.'],
    ['HELP', "You can reply 'help' anytime."],
    ['ARRET', 'Écrivez-moi « arrêt » quand vous voulez.'],
    ['AIDE', 'Tapez aide au besoin.'],
    ['STOP', '\uff33\uff34\uff2f\uff30 works anytime.'],
    ['STOP', 'Reply S\u200BTOP anytime.'],
    ['STOP', 'Reply sToP anytime.'],
    ['ARRET', 'Répondez ARRE\u0302T.'],
    ['STOP', 'If you want out, "Stop" does it.'],
  ])('names %s however a draft teaches it: %s', (keyword, text) => {
    expect(namesOptOutKeyword(text)).toBe(keyword);
  });

  it.each([
    'Tell me if you want me to stop.',
    'Tell me to stop and I will.',
    'Text me if you need help.',
    'Just text me and I can help.',
    'I can help with pickup.',
    'Stop by anytime.',
    'You can text me anytime. Stop by if you like.',
    'You can text me anytime.\nStop by if you like.',
    "Dites-moi si vous voulez que j'arrête.",
    "Écrivez-moi pour de l'aide.",
    "L'arrêt de bus est rue King.",
    "C'est une bonne aide pour la semaine.",
  ])('passes a plain sentence: %s', (text) => {
    expect(namesOptOutKeyword(text)).toBeNull();
  });

  describe('a piece the line must carry word for word', () => {
    const PLACE = 'BUS STOP 14, King St';

    it('does not count as the draft naming a keyword', () => {
      expect(namesOptOutKeyword(`Pickup at 4:15, ${PLACE}.`, [PLACE])).toBeNull();
    });

    it('positive control: the same line without the piece handed is refused', () => {
      expect(namesOptOutKeyword(`Pickup at 4:15, ${PLACE}.`)).toBe('STOP');
    });

    it('still refuses a keyword taught around it', () => {
      expect(namesOptOutKeyword(`${PLACE}. Reply STOP anytime.`, [PLACE])).toBe('STOP');
      expect(namesOptOutKeyword(`${PLACE}. Just text "stop" to leave.`, [PLACE])).toBe('STOP');
    });

    it('still refuses a piece that is itself the instruction', () => {
      const hostile = 'Text stop to 12345';
      expect(namesOptOutKeyword(`Pickup at ${hostile}.`, [hostile])).toBe('STOP');
    });
  });

  it('names the opt-out line in any case', () => {
    expect(namesOptOutKeyword('see you then. reply stop to opt out.')).toBe('opt_out_line');
    expect(writesOptOutLine('STOP TO OPT OUT.')).toBe(true);
  });

  it.each([
    "If you'd rather I stop, just tell me.",
    'The bus STOPPED early and the HELPER waited.',
    'AIDES and STOPS are not keywords.',
    'Asking for help and aide in lowercase is just words.',
  ])('passes plain words: %s', (text) => {
    expect(namesOptOutKeyword(text)).toBeNull();
  });

  it('reserves the longer line for budgets without handing it out', () => {
    expect(OPT_OUT_LINE_CHARS).toBe(OPT_OUT_LINE.length);
    expect(segmentsWithOptOutReserved('Swim is at 10.')).toBe(1);
    expect(segmentsWithOptOutReserved('x'.repeat(160 - OPT_OUT_LINE.length - 2))).toBe(1);
    expect(segmentsWithOptOutReserved('x'.repeat(161 - OPT_OUT_LINE.length - 2))).toBe(2);
    expect(OPT_OUT_SHORT.length).toBeLessThan(OPT_OUT_LINE.length);
  });
});
