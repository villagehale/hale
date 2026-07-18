import { describe, expect, it } from 'vitest';
import { TEEN_REDACTED_PLACEHOLDER } from '~/lib/dashboard/mappers';
import {
  type ActionMessageRow,
  type DigestMessageRow,
  toActionMessage,
  toDigestMessage,
} from './mappers';

const TZ = 'America/Toronto';

const DIGEST: DigestMessageRow = {
  id: '11111111-1111-4111-8111-111111111111',
  briefText: 'A calm day — one feed logged, nothing needs you.',
  generatedAt: new Date('2026-06-17T13:00:00.000Z'),
};

const ACTION: ActionMessageRow = {
  id: '22222222-2222-4222-8222-222222222222',
  actionType: 'reply_to_email',
  state: 'drafted_for_approval',
  at: new Date('2026-06-17T15:00:00.000Z'),
  revertedReason: null,
  teenContent: false,
};

describe('toDigestMessage', () => {
  it('surfaces the brief prose wholesale (already a pre-redacted parent slice)', () => {
    const view = toDigestMessage(DIGEST, TZ);
    expect(view.kind).toBe('digest');
    expect(view.eyebrow).toBe('Daily brief');
    expect(view.body).toBe('A calm day — one feed logged, nothing needs you.');
    // 13:00 UTC is 09:00 in America/Toronto (EDT).
    expect(view.when).toBe('Jun 17, 09:00');
    // A digest never navigates — no action state.
    expect(view.actionState).toBeUndefined();
  });

  it('namespaces the id so a digest and an action never collide', () => {
    expect(toDigestMessage(DIGEST, TZ).id).toBe(`digest-${DIGEST.id}`);
  });
});

describe('toActionMessage — lifecycle framing', () => {
  it('frames a drafted action as awaiting the parent, tagged with the state so it navigates', () => {
    const view = toActionMessage(ACTION, TZ);
    expect(view.kind).toBe('action');
    expect(view.eyebrow).toBe('Reply to email');
    expect(view.body).toBe('Hale drafted "Reply to email" for your yes.');
    expect(view.actionState).toBe('drafted_for_approval');
    expect(view.teenRedacted).toBe(false);
    // 15:00 UTC is 11:00 in America/Toronto (EDT).
    expect(view.when).toBe('Jun 17, 11:00');
  });

  it('frames an executed (autonomous) action as done by Hale', () => {
    const view = toActionMessage(
      { ...ACTION, actionType: 'create_calendar_event', state: 'autonomous' },
      TZ,
    );
    expect(view.body).toBe('Hale handled "Add to calendar".');
    expect(view.actionState).toBe('autonomous');
  });

  it('frames a needs_human action as needing the parent', () => {
    const view = toActionMessage(
      { ...ACTION, actionType: 'place_supply_order', state: 'needs_human' },
      TZ,
    );
    expect(view.body).toBe('"Order supplies" needs you.');
  });

  it('frames a declined draft as declined — never a rollback of an action that never ran', () => {
    const view = toActionMessage(
      { ...ACTION, state: 'reverted', revertedReason: 'declined_by_human' },
      TZ,
    );
    expect(view.body).toBe('You declined "Reply to email".');
  });

  it('frames a true revert of an executed action as rolled back', () => {
    const view = toActionMessage({ ...ACTION, state: 'reverted', revertedReason: null }, TZ);
    expect(view.body).toBe('You rolled back "Reply to email".');
  });
});

describe('today flag — the notifications TODAY/EARLIER split (family zone)', () => {
  // 2026-06-17T13:00:00Z is Jun 17 in America/Toronto.
  it('is true when the row falls on the same family-zone day as now', () => {
    const now = new Date('2026-06-17T22:00:00.000Z'); // still Jun 17, 18:00 ET
    expect(toDigestMessage(DIGEST, TZ, now).today).toBe(true);
    expect(toActionMessage(ACTION, TZ, now).today).toBe(true);
  });

  it('is false when the row is on an earlier family-zone day than now', () => {
    const now = new Date('2026-06-20T13:00:00.000Z'); // Jun 20 ET
    expect(toDigestMessage(DIGEST, TZ, now).today).toBe(false);
    expect(toActionMessage(ACTION, TZ, now).today).toBe(false);
  });

  it('judges the day in the family zone, not UTC (a 01:00Z row is the prior ET day)', () => {
    // 2026-06-18T01:00:00Z is Jun 17, 21:00 in America/Toronto — the family's
    // Jun 17, not UTC's Jun 18.
    const row: DigestMessageRow = { ...DIGEST, generatedAt: new Date('2026-06-18T01:00:00.000Z') };
    const nowSameEtDay = new Date('2026-06-18T02:00:00.000Z'); // Jun 17, 22:00 ET
    const nowNextEtDay = new Date('2026-06-18T05:00:00.000Z'); // Jun 18, 01:00 ET
    expect(toDigestMessage(row, TZ, nowSameEtDay).today).toBe(true);
    expect(toDigestMessage(row, TZ, nowNextEtDay).today).toBe(false);
  });
});

describe('toActionMessage — teen redaction (rule #1)', () => {
  it('redacts the body AND eyebrow for a teen action — the raw action type never reaches the view', () => {
    const view = toActionMessage(
      { ...ACTION, actionType: 'reply_to_email', teenContent: true },
      TZ,
    );
    expect(view.body).toBe(TEEN_REDACTED_PLACEHOLDER);
    expect(view.eyebrow).toBe('Private');
    expect(view.teenRedacted).toBe(true);
    // The human action label is withheld too — nothing about the teen's action leaks.
    expect(JSON.stringify(view)).not.toContain('Reply to email');
  });

  it('still tags the redacted row with its lifecycle state (the frame survives, the content does not)', () => {
    const view = toActionMessage({ ...ACTION, teenContent: true }, TZ);
    expect(view.actionState).toBe('drafted_for_approval');
  });
});
