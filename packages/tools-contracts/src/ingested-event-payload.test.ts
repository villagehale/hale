import { describe, expect, it } from 'vitest';
import { ingestedEventPayloadSchema } from './index.js';

/**
 * Cases are hand-derived from the schema constraints in index.ts and from the
 * exact object the web route constructs in
 * apps/web/app/api/webhooks/[provider]/route.ts (queue.send('events.ingested', …)).
 * The accept fixture is built by hand from that source — NOT by running the route.
 */

// Mirrors the literal the web route hands to queue.send: family_id from
// resolveFamilyFromWebhook (a UUID), source = provider, payload = parsed JSON
// body, received_at = new Date().toISOString().
const validPayload = {
  family_id: '11111111-1111-4111-8111-111111111111',
  source: 'gmail',
  payload: { messageId: 'abc', from: 'clinic@example.com' },
  received_at: '2026-06-12T10:00:00.000Z',
};

describe('ingestedEventPayloadSchema', () => {
  it('accepts the exact shape the web route constructs', () => {
    const result = ingestedEventPayloadSchema.safeParse(validPayload);
    expect(result.success).toBe(true);
  });

  it('rejects a payload missing family_id', () => {
    const { family_id, ...withoutFamilyId } = validPayload;
    const result = ingestedEventPayloadSchema.safeParse(withoutFamilyId);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path[0] === 'family_id')).toBe(true);
    }
  });

  it('rejects a family_id that is not a UUID', () => {
    const result = ingestedEventPayloadSchema.safeParse({
      ...validPayload,
      family_id: 'not-a-uuid',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path[0] === 'family_id')).toBe(true);
    }
  });

  it('rejects an empty source', () => {
    const result = ingestedEventPayloadSchema.safeParse({ ...validPayload, source: '' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path[0] === 'source')).toBe(true);
    }
  });

  it('rejects a non-object payload', () => {
    const result = ingestedEventPayloadSchema.safeParse({
      ...validPayload,
      payload: 'not-an-object',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path[0] === 'payload')).toBe(true);
    }
  });

  it('rejects a received_at that is not an ISO datetime', () => {
    const result = ingestedEventPayloadSchema.safeParse({
      ...validPayload,
      received_at: 'yesterday',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path[0] === 'received_at')).toBe(true);
    }
  });
});
