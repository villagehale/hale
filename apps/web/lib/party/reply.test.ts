import { describe, expect, it } from 'vitest';
import {
  looksLikePartyMessage,
  matchPartyCancel,
  matchPartyLinkConfirm,
  matchPartyTallyAsk,
} from './reply';

/**
 * VIL-245 · M10 — the deterministic matchers the inbound router calls.
 *
 * Exact on the normalized body, never a substring, for the reason the CASL keywords and
 * M7/M8's reply matchers give: "not done yet" contains "done". Here the stakes are a
 * publish and a cancel, so the tests below are mostly about what must NOT match.
 */

describe('matchPartyLinkConfirm', () => {
  it('accepts the plain affirmatives a parent actually texts', () => {
    for (const body of ['yes', 'YES', ' yes ', 'yes please', 'yep', 'sure', 'ok', 'do it']) {
      expect(matchPartyLinkConfirm(body)).toBe(true);
    }
  });

  it('refuses a sentence that merely contains a yes', () => {
    // Publishing a page with a family's address on it off a substring match is the
    // failure this matcher exists to prevent.
    for (const body of [
      'yes to the swim class not the party',
      'no yes I mean no',
      'yesterday was better',
      'not yet',
    ]) {
      expect(matchPartyLinkConfirm(body)).toBe(false);
    }
  });

  it('refuses a refusal', () => {
    for (const body of ['no', 'no thanks', 'nope', "don't"]) {
      expect(matchPartyLinkConfirm(body)).toBe(false);
    }
  });
});

describe('matchPartyTallyAsk', () => {
  it('recognises the ways a host asks for the headcount', () => {
    for (const body of [
      "who's coming?",
      'whos coming',
      'who is coming',
      'headcount',
      'rsvps',
      'how many are coming',
    ]) {
      expect(matchPartyTallyAsk(body)).toBe(true);
    }
  });

  it('does not fire on an unrelated question', () => {
    expect(matchPartyTallyAsk('who is picking up Max')).toBe(false);
    expect(matchPartyTallyAsk('coming home late')).toBe(false);
  });
});

describe('matchPartyCancel', () => {
  it('recognises an explicit cancellation', () => {
    for (const body of ['cancel the party', 'cancel party', "party's off", 'call off the party']) {
      expect(matchPartyCancel(body)).toBe(true);
    }
  });

  it('never fires on a message that only mentions cancelling something else', () => {
    // A cancel closes the page AND texts every opted-in guest. It has to be said, not
    // implied.
    for (const body of ['cancel swim class', 'cancel', "don't cancel the party", 'uncancel']) {
      expect(matchPartyCancel(body)).toBe(false);
    }
  });
});

describe('looksLikePartyMessage', () => {
  it('lets a party-shaped message through to the extractor', () => {
    expect(looksLikePartyMessage("Max's 5th birthday, Aug 23, 2pm, our place")).toBe(true);
    expect(looksLikePartyMessage("we're throwing a party for Leo Saturday")).toBe(true);
  });

  it('keeps ordinary traffic away from a model call', () => {
    // This is a COST filter, not the decision — the extractor still answers is_party.
    expect(looksLikePartyMessage('running 10 min late for pickup')).toBe(false);
    expect(looksLikePartyMessage('yes')).toBe(false);
  });
});
