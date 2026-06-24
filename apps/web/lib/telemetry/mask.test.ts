import { describe, expect, it } from 'vitest';
import { haleMask } from './mask';

/**
 * The shared Langfuse mask is the hard-rule-#1 backstop: teen raw content + contact
 * PII must NEVER reach a trace, while non-teen content and a child's first name/DOB
 * MAY (HIPAA-grade). Assertions derive from rule #1, not from the code's output.
 */

describe('haleMask — rule #1 redaction', () => {
  it('redacts a 13+ child\'s raw content when the payload is teen-flagged', () => {
    const data = JSON.stringify({
      teen_content: true,
      event_type: 'school_communication',
      raw_content: "mom I'm staying late at Jordan's after the dance, back by 11",
    });

    const out = haleMask({ data });

    expect(out).not.toContain('staying late');
    expect(out).not.toContain('Jordan');
    expect(out).toContain('[REDACTED_TEEN_CONTENT]');
    // Category is kept so the trace stays diagnosable.
    expect(out).toContain('school_communication');
  });

  it('redacts nested teen content (signal wrapped one level down)', () => {
    const data = JSON.stringify({
      signal: { source: 'sms', raw_content: 'private teen message body' },
      family_context_slice: { teen_content: true },
    });

    const out = haleMask({ data });

    expect(out).not.toContain('private teen message body');
    expect(out).toContain('[REDACTED_TEEN_CONTENT]');
  });

  it('redacts email, phone, Canadian postal code, and street address unconditionally', () => {
    const data = JSON.stringify({
      note: 'reach me at jane.doe@example.com or 416-555-0199, 55 King Street, M5V 2T6',
    });

    const out = haleMask({ data });

    expect(out).not.toContain('jane.doe@example.com');
    expect(out).not.toContain('416-555-0199');
    expect(out).not.toContain('M5V 2T6');
    expect(out).not.toContain('55 King Street');
    expect(out).toContain('[REDACTED_EMAIL]');
    expect(out).toContain('[REDACTED_PHONE]');
    expect(out).toContain('[REDACTED_POSTAL]');
    expect(out).toContain('[REDACTED_ADDRESS]');
  });

  it('scrubs PII from non-JSON prose (an answer string)', () => {
    const out = haleMask({ data: 'Call the clinic at (514) 555-0123 to book.' });

    expect(out).not.toContain('555-0123');
    expect(out).toContain('[REDACTED_PHONE]');
  });

  it('redacts a bare 10-digit phone number with no separators', () => {
    const out = haleMask({ data: 'reach the office at 4165550199 anytime' });

    expect(out).not.toContain('4165550199');
    expect(out).toContain('[REDACTED_PHONE]');
  });

  it('does NOT redact a child DOB or a short order number as a phone (no false positive)', () => {
    const out = haleMask({ data: JSON.stringify({ dob: '2024-03-15', order: '#1234567' }) });

    expect(out).toContain('2024-03-15');
    expect(out).toContain('1234567');
    expect(out).not.toContain('[REDACTED_PHONE]');
  });

  it('keeps non-teen content and a child first name + DOB (HIPAA-grade, not masked)', () => {
    const data = JSON.stringify({
      teen_content: false,
      child: { name: 'Mia', dob: '2024-03-15' },
      raw_content: 'Mia has her 6-month vaccine appointment Tuesday',
    });

    const out = haleMask({ data });

    expect(out).toContain('Mia');
    expect(out).toContain('2024-03-15');
    expect(out).toContain('6-month vaccine appointment');
    expect(out).not.toContain('[REDACTED_TEEN_CONTENT]');
  });

  it('never throws and always returns a string for odd input', () => {
    expect(typeof haleMask({ data: undefined })).toBe('string');
    expect(typeof haleMask({ data: 42 })).toBe('string');
    expect(typeof haleMask({ data: { a: 1 } })).toBe('string');
  });
});
