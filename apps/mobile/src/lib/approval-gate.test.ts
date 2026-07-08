import { describe, expect, it } from 'vitest';

import {
  approveResult,
  approvedPostState,
  buildActionRequest,
  declineResult,
  parseDraftResponse,
} from './approval-gate';

/**
 * The pure decision logic of the inline approval gate. Each assertion is derived
 * from the shipping route contract (202 draft w/ actionId, 202 approve, 200
 * decline), not from what the code happens to return — a wrong status must fail.
 */

describe('buildActionRequest', () => {
  it('omits focusedChildId for a whole-family draft (the mobile chat scope)', () => {
    expect(buildActionRequest('draft_email', null, 'Naps get shorter around now.')).toEqual({
      intentKind: 'draft_email',
      sourceAnswer: 'Naps get shorter around now.',
    });
  });

  it('includes focusedChildId when a child is in scope', () => {
    expect(buildActionRequest('add_to_routine', 'child-7', 'Pin the bedtime routine.')).toEqual({
      intentKind: 'add_to_routine',
      focusedChildId: 'child-7',
      sourceAnswer: 'Pin the bedtime routine.',
    });
  });
});

describe('parseDraftResponse', () => {
  it('returns the actionId on a 202 that carries a string id', () => {
    expect(parseDraftResponse({ status: 202, actionId: 'act-123' })).toBe('act-123');
  });

  it('returns null on a 202 missing the actionId', () => {
    expect(parseDraftResponse({ status: 202 })).toBeNull();
  });

  it('returns null on a 202 whose actionId is not a string', () => {
    expect(parseDraftResponse({ status: 202, actionId: 42 })).toBeNull();
  });

  it('returns null on a non-202 (so no card is wired to nothing)', () => {
    expect(parseDraftResponse({ status: 400, actionId: 'act-123' })).toBeNull();
    expect(parseDraftResponse({ status: 401, actionId: 'act-123' })).toBeNull();
  });
});

describe('approveResult', () => {
  it("settles a 202 to 'approved' (queued for the drain — honest, not 'done')", () => {
    expect(approveResult(202)).toBe('approved');
  });

  it("settles a non-202 to 'error'", () => {
    expect(approveResult(200)).toBe('error');
    expect(approveResult(409)).toBe('error');
    expect(approveResult(500)).toBe('error');
  });
});

describe('declineResult', () => {
  it("settles a 200 to 'dismissed'", () => {
    expect(declineResult(200)).toBe('dismissed');
  });

  it("settles a non-200 to 'error'", () => {
    expect(declineResult(202)).toBe('error');
    expect(declineResult(404)).toBe('error');
    expect(declineResult(500)).toBe('error');
  });
});

describe('approvedPostState — honest post-approval copy', () => {
  it('tells the parent Hale is on it for a wired executor (email / digest / routine)', () => {
    expect(approvedPostState('send_email')).toBe('Approved — Hale is on it.');
    expect(approvedPostState('reply_to_email')).toBe('Approved — Hale is on it.');
    expect(approvedPostState('add_to_digest_only')).toBe('Approved — Hale is on it.');
    expect(approvedPostState('add_to_routine')).toBe('Approved — Hale is on it.');
  });

  it('never fakes success for an unwired executor — calendar waits for the integration', () => {
    const line = 'Approved — Hale will handle this as integrations come online.';
    expect(approvedPostState('create_calendar_event')).toBe(line);
    expect(approvedPostState('update_calendar_event')).toBe(line);
    expect(approvedPostState('place_supply_order')).toBe(line);
    // An unknown action type fails closed to the honest "coming online" line.
    expect(approvedPostState('some_future_type')).toBe(line);
  });
});
