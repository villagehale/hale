import { describe, expect, it } from 'vitest';
import { assertNoPII, EMAIL_RE, redactEventPayload, redactText } from './redact.js';

/**
 * The redactor is the rule-#1 gate for the shadow eval: it strips family PII from
 * an input BEFORE a prompt sees it, and assertNoPII fails CLOSED — if any PII
 * pattern survives, it throws, so the caller drops the input rather than leak it.
 * Expected values are derived from the spec (placeholders + absence of the raw
 * PII), not from the function's own output.
 */
describe('redactText', () => {
  it('replaces a known child name (case-insensitive, whole word) with [CHILD]', () => {
    const out = redactText('Maya has a fever; maya slept well', ['Maya']);
    expect(out).not.toMatch(/maya/i);
    expect(out).toBe('[CHILD] has a fever; [CHILD] slept well');
  });

  it('does NOT redact a substring match (Mayan stays)', () => {
    expect(redactText('the Mayan calendar', ['Maya'])).toBe('the Mayan calendar');
  });

  it('redacts ISO dates, Canadian postal codes, emails, and phone numbers', () => {
    const raw = 'born 2023-04-01, at M5V 2T6, email a@b.ca, call 416-555-0199';
    const out = redactText(raw, []);
    expect(out).not.toContain('2023-04-01');
    expect(out).not.toContain('M5V 2T6');
    expect(out).not.toContain('a@b.ca');
    expect(out).not.toContain('416-555-0199');
    expect(out).toContain('[DATE]');
    expect(out).toContain('[POSTAL]');
    expect(out).toContain('[EMAIL]');
    expect(out).toContain('[PHONE]');
  });

  it('redacts a US ZIP and a ZIP+4 by the matcher every search shares', () => {
    const out = redactText('swim near 99999, or 99999-0000', []);
    expect(out).not.toContain('99999');
    expect(out).not.toContain('0000');
    expect(out).toBe('swim near [POSTAL], or [POSTAL]');
  });

  it('redacts a postal code typed in full-width characters', () => {
    expect(redactText('swim near Ｚ９Ｚ ９Ｚ９', [])).toBe('swim near [POSTAL]');
  });

  it('keeps a price, which is not a place (positive control)', () => {
    expect(redactText('a $12345 budget', [])).toBe('a $12345 budget');
  });

  it('redacts every known name, not just the first', () => {
    const out = redactText('Liam and Ava played', ['Liam', 'Ava']);
    expect(out).toBe('[CHILD] and [CHILD] played');
  });
});

describe('assertNoPII (fail-closed)', () => {
  it('passes clean redacted text', () => {
    expect(() => assertNoPII('[CHILD] is at [POSTAL]', ['Maya'])).not.toThrow();
  });

  it('THROWS if a known name survived (leak → drop, never pass)', () => {
    expect(() => assertNoPII('Maya is here', ['Maya'])).toThrow(/PII/i);
  });

  it('THROWS if a raw date/postal/email/phone survived', () => {
    expect(() => assertNoPII('born 2023-04-01', [])).toThrow(/PII/i);
    expect(() => assertNoPII('at M5V 2T6', [])).toThrow(/PII/i);
    expect(() => assertNoPII('a@b.ca', [])).toThrow(/PII/i);
  });

  it('THROWS if a raw US ZIP survived', () => {
    expect(() => assertNoPII('swim near 99999', [])).toThrow(/postal/);
  });
});

describe('redactEventPayload', () => {
  it('deep-redacts string values in a nested payload, leaves structure', () => {
    const payload = {
      event_type: 'health_note',
      text: 'Maya has a rash, born 2023-04-01',
      meta: { note: 'call 416-555-0199' },
      count: 3,
    };
    const out = redactEventPayload(payload, ['Maya']);
    expect(out.event_type).toBe('health_note');
    expect(out.count).toBe(3);
    expect(out.text).toBe('[CHILD] has a rash, born [DATE]');
    expect(out.meta.note).toBe('call [PHONE]');
    // and the whole thing passes the fail-closed check
    expect(() => assertNoPII(JSON.stringify(out), ['Maya'])).not.toThrow();
  });

  // /api/events/ingest spreads a provider's `extra` onto the top level, so a top-level id
  // can hold anything a person wrote.
  it.each([
    ["a child's first name", 'Maya', '[CHILD]'],
    ['ten digits', '5555550123', '[PHONE]'],
    ['a ZIP', '99999', '[POSTAL]'],
  ])('redacts a top-level id holding %s', (_label, id, redacted) => {
    expect(redactEventPayload({ id }, ['Maya']).id).toBe(redacted);
  });

  it('leaves a top-level id with nothing in it to redact (positive control)', () => {
    expect(redactEventPayload({ id: 'plain-id_token' }, ['Maya']).id).toBe('plain-id_token');
  });

  it('still scrubs the text fields beside a provider id', () => {
    const out = redactEventPayload({ id: '0e14f18e70064eda', snippet: 'pool near 99999' }, []);
    expect(out.snippet).toBe('pool near [POSTAL]');
  });

  it('scrubs a top-level id that holds text rather than an opaque token', () => {
    expect(redactEventPayload({ id: 'near 99999' }, []).id).toBe('near [POSTAL]');
    expect(redactEventPayload({ id: 'a@b.ca' }, []).id).toBe('[EMAIL]');
  });

  it('scrubs a nested id, which no provider sends, as text', () => {
    const out = redactEventPayload({ extra: { id: 'near 99999' } }, []);
    expect(out.extra.id).toBe('near [POSTAL]');
  });
});

describe('the address pass', () => {
  /** The pattern as it was before it stopped retrying inside a run, as the reference. */
  const EVERY_START = /[\w.+-]+@[\w-]+\.[\w.-]+/g;

  /** A deterministic stream (mulberry32), so a failure replays. */
  function seeded(seed: number): () => number {
    let state = seed;
    return () => {
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // No digits, so no other pass in redactText can touch these strings.
  const PIECES = ['a', 'b.c', 'd-e', 'f_g', '+', '+', '@', '@', '.', '-', ' ', ','];

  function corpus(size: number): string[] {
    const next = seeded(620);
    return Array.from({ length: size }, () => {
      const pieces = 2 + Math.floor(next() * 12);
      return Array.from({ length: pieces }, () => PIECES[Math.floor(next() * PIECES.length)]).join(
        '',
      );
    });
  }

  it('redacts both addresses when a plus joins them', () => {
    expect(redactText('a@b.ca+c@d.ca', [])).toBe('[EMAIL][EMAIL]');
    expect(() => assertNoPII(redactText('a@b.ca+c@d.ca+e@f.ca', []))).not.toThrow();
  });

  it('takes the same matches as trying every start', () => {
    const strings = corpus(20_000);
    // Positive control: the corpus holds the case a start-of-run guard alone would miss.
    expect(strings.some((s) => /@[\w-]+\.[\w.-]+\+[\w.+-]*@[\w-]+\.\w/.test(s))).toBe(true);
    for (const s of strings) {
      expect(redactText(s, [])).toBe(s.replace(EVERY_START, '[EMAIL]'));
    }
  });

  /** The pattern's guards alone, sticky: true at a position where a match may begin. */
  function guardsOf(pattern: RegExp): RegExp {
    const opening = pattern.source.indexOf(String.raw`[\w.+-]+@`);
    if (opening < 0) throw new Error('no address opening in the pattern');
    return new RegExp(pattern.source.slice(0, opening), 'y');
  }

  /** The starts the guards admit on `text`, and the work of them: one for each start and
   * one for each character the pattern's opening repeat then reads. A count, so a loaded
   * machine cannot move it the way it moves a clock. */
  function startWork(guards: RegExp, text: string): { starts: number; work: number } {
    const opening = /[\w.+-]*/y;
    let starts = 0;
    let work = 0;
    for (let at = 0; at <= text.length; at += 1) {
      guards.lastIndex = at;
      if (!guards.test(text)) continue;
      opening.lastIndex = at;
      starts += 1;
      work += 1 + (opening.exec(text) as RegExpExecArray)[0].length;
    }
    return { starts, work };
  }

  it('starts once in a run of address characters, however long it is', () => {
    expect(startWork(guardsOf(EMAIL_RE), 'a'.repeat(2_000)).starts).toBe(1);
    expect(startWork(guardsOf(EMAIL_RE), 'a'.repeat(4_000)).starts).toBe(1);
  });

  it.each(['a', 'a+', 'a@b.ca+'])('does work proportional to a run of %j', (piece) => {
    const work = (copies: number) => startWork(guardsOf(EMAIL_RE), piece.repeat(copies)).work;
    expect(work(4_000) / work(2_000)).toBeLessThan(2.1);
  });

  it('counts the pattern as it was going quadratic (positive control)', () => {
    const work = (copies: number) => startWork(guardsOf(EVERY_START), 'a'.repeat(copies)).work;
    expect(work(4_000) / work(2_000)).toBeGreaterThan(3);
  });
});
