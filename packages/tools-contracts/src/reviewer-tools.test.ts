import { describe, expect, it } from 'vitest';
import { REVIEWER_TOOLS } from './index.js';

/**
 * Expectations are hand-derived from the Zod schema declarations in index.ts,
 * not copied from runtime output. Each malformed case targets a specific
 * constraint in the schema source.
 */

describe('REVIEWER_TOOLS.check_calendar_conflict input', () => {
  const schema = REVIEWER_TOOLS.check_calendar_conflict.input;

  it('rejects a familyId that is not a UUID', () => {
    const result = schema.safeParse({
      familyId: 'not-a-uuid',
      startsAt: '2026-06-12T10:00:00.000Z',
      durationMinutes: 30,
    });
    expect(result.success).toBe(false);
  });

  it('rejects durationMinutes of zero (schema requires positive)', () => {
    const result = schema.safeParse({
      familyId: '11111111-1111-4111-8111-111111111111',
      startsAt: '2026-06-12T10:00:00.000Z',
      durationMinutes: 0,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-integer durationMinutes', () => {
    const result = schema.safeParse({
      familyId: '11111111-1111-4111-8111-111111111111',
      startsAt: '2026-06-12T10:00:00.000Z',
      durationMinutes: 1.5,
    });
    expect(result.success).toBe(false);
  });

  it('rejects when the required startsAt field is missing', () => {
    const result = schema.safeParse({
      familyId: '11111111-1111-4111-8111-111111111111',
      durationMinutes: 30,
    });
    expect(result.success).toBe(false);
  });

  it('accepts a well-formed input', () => {
    const result = schema.safeParse({
      familyId: '11111111-1111-4111-8111-111111111111',
      startsAt: '2026-06-12T10:00:00.000Z',
      durationMinutes: 30,
    });
    expect(result.success).toBe(true);
  });
});

describe('REVIEWER_TOOLS.check_spending_cap input', () => {
  const schema = REVIEWER_TOOLS.check_spending_cap.input;

  it('rejects a negative amountUsd (schema requires nonnegative)', () => {
    const result = schema.safeParse({
      familyId: '22222222-2222-4222-8222-222222222222',
      amountUsd: -1,
      category: 'groceries',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-string category', () => {
    const result = schema.safeParse({
      familyId: '22222222-2222-4222-8222-222222222222',
      amountUsd: 10,
      category: 42,
    });
    expect(result.success).toBe(false);
  });

  it('accepts amountUsd of zero (nonnegative includes zero)', () => {
    const result = schema.safeParse({
      familyId: '22222222-2222-4222-8222-222222222222',
      amountUsd: 0,
      category: 'groceries',
    });
    expect(result.success).toBe(true);
  });
});

describe('REVIEWER_TOOLS.check_recipient_allowlist input', () => {
  const schema = REVIEWER_TOOLS.check_recipient_allowlist.input;

  it('rejects a recipientCategory outside the declared enum', () => {
    const result = schema.safeParse({
      familyId: '33333333-3333-4333-8333-333333333333',
      recipient: 'clinic@example.com',
      recipientCategory: 'spam',
    });
    expect(result.success).toBe(false);
  });

  it('rejects when the required recipient field is missing', () => {
    const result = schema.safeParse({
      familyId: '33333333-3333-4333-8333-333333333333',
      recipientCategory: 'medical',
    });
    expect(result.success).toBe(false);
  });

  it('accepts a well-formed input with a valid enum member', () => {
    const result = schema.safeParse({
      familyId: '33333333-3333-4333-8333-333333333333',
      recipient: 'clinic@example.com',
      recipientCategory: 'medical',
    });
    expect(result.success).toBe(true);
  });
});
