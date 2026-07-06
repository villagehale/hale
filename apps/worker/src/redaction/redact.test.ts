import { describe, expect, it } from 'vitest';
import { assertNoPII, redactEventPayload, redactText } from './redact.js';

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
});
