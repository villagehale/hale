import { describe, expect, it } from 'vitest';
import { CONSUMED_SEND_STATUSES, SENT_STATUSES, acceptedStatus } from './ledger';

/**
 * Launch-day review P0 (2026-08-11): with 'failed' missing from the consumed
 * set, an undelivered receipt (real since #396) un-consumed the dedupe key for
 * every reader while the DB unique index still held it — re-send, 23505 crash,
 * no audit row, repeating every slot. The fake-db convention here evaluates no
 * WHERE clauses, so this test pins the PREDICATE itself: the one list both
 * dedupeActive and the told-marker reader filter on.
 */
describe('CONSUMED_SEND_STATUSES — a provider attempt consumes idempotency forever', () => {
  it("counts 'failed' as consumed — a lost delivery must never re-arm its own key", () => {
    expect(CONSUMED_SEND_STATUSES).toContain('failed');
  });

  it('covers every status a provider attempt can land in', () => {
    expect([...CONSUMED_SEND_STATUSES].sort()).toEqual(
      ['delivered', 'failed', 'queued', 'sent'].sort(),
    );
  });
});

/**
 * WHAT A LEDGER ROW CLAIMS AT BIRTH.
 *
 * Twilio ACCEPTS a message and transmits it later — one segment per second from a
 * Canadian long code — so 'sent' written the moment the API answered was asserting a
 * carrier handoff nobody had observed. It also hid the one thing worth watching during
 * a burst: with every row born 'sent', a queue of messages waiting for airtime looks
 * exactly like a queue that already went out. 'queued' is what we actually know, and
 * the delivery receipt advances it (channel/twilio/status.ts).
 *
 * Channels with no delivery receipt wired stay terminal on accept — a row that could
 * never leave 'queued' would be a permanent lie in the other direction.
 */
describe('acceptedStatus — the status a successful send starts at', () => {
  it('starts an SMS at queued: the provider took it, the carrier has not confirmed it', () => {
    expect(acceptedStatus('sms')).toBe('queued');
  });

  it('leaves the receipt-less channels terminal on accept', () => {
    expect(acceptedStatus('email')).toBe('sent');
    expect(acceptedStatus('push')).toBe('sent');
  });
});

/**
 * Every "have we already sent this?" reader filters on this ONE list. An SMS row now
 * spends its first seconds in 'queued', so a reader that still asked for ['sent',
 * 'delivered'] would answer "no" about a message that is already on its way — and send
 * a second one (a doubled cap, a second identity ask, a re-asked email question).
 */
describe('SENT_STATUSES — the send happened, and nothing came back to say otherwise', () => {
  it('counts a row still waiting for its receipt', () => {
    expect(SENT_STATUSES).toContain('queued');
  });

  it('is the consumed set minus the one status that means it did not arrive', () => {
    expect([...SENT_STATUSES].sort()).toEqual(
      [...CONSUMED_SEND_STATUSES].filter((status) => status !== 'failed').sort(),
    );
    expect(SENT_STATUSES).not.toContain('failed');
  });
});
