import { describe, expect, it } from 'vitest';
import { partyRecorded } from './copy';
import {
  type PartyReplyDeps,
  handlePartyReply,
  looksLikePartyMessage,
  matchPartyCancel,
  matchPartyTallyAsk,
} from './reply';

/**
 * VIL-245 · M10 — the deterministic matchers the inbound router calls.
 *
 * Exact on the normalized body, never a substring, for the reason the CASL keywords and
 * M7/M8's reply matchers give: "not done yet" contains "done". Here the stakes are a
 * publish and a cancel, so the tests below are mostly about what must NOT match.
 */

describe('partyRecorded', () => {
  it('asks whether to make the link, and does not name a keyword', () => {
    expect(partyRecorded('Saturday at 2', "Leo's party", 'the park')).toBe(
      "Got it - Leo's party, Saturday at 2 at the park. Want me to make a link guests can RSVP to?",
    );
    expect(partyRecorded('Saturday at 2', "Leo's party", null)).toBe(
      "Got it - Leo's party, Saturday at 2. Want me to make a link guests can RSVP to?",
    );
    expect(partyRecorded('Saturday at 2', "Leo's party", 'the park')).not.toMatch(/reply yes/i);
  });
});

/**
 * VIL-265 — the widened vocabulary does NOT widen what any one word authorises.
 *
 * Reading more phrases as "yes" is only safe because the gate is somewhere else: the
 * fresh-offer lookup. These two cases are the same message answered in two different
 * states, and the difference between them is the whole safety argument for sharing a
 * vocabulary across handlers that mean different things by a yes.
 */
describe('handlePartyReply · an affirmative claims only a live offer', () => {
  function deps(pending: { familyEventId: string } | null): PartyReplyDeps {
    return {
      loadPendingOffer: async () => pending,
      mintInvite: async () => ({ inviteId: 'invite-1', publicToken: 'tok-1' }) as never,
      loadLiveInvite: async () => null,
      loadTally: async () => ({}) as never,
      cancelInvite: async () => undefined as never,
      loadTeenNames: async () => [],
    };
  }

  const input = { familyId: 'fam-1', parentUserId: 'user-1', now: new Date() };

  it('mints nothing when no offer is open, even when the model read a yes', async () => {
    const outcome = await handlePartyReply(
      {} as never,
      { ...input, body: 'go ahead', confirmed: true },
      deps(null),
    );
    expect(outcome).toEqual({ status: 'ignored', reason: 'no_pending_offer' });
  });

  it('mints once an offer is live and the model read a yes', async () => {
    const outcome = await handlePartyReply(
      {} as never,
      { ...input, body: 'go ahead', confirmed: true },
      deps({ familyEventId: 'event-1' }),
    );
    expect(outcome.status).toBe('link_minted');
  });

  it('does not mint from the words alone', async () => {
    const outcome = await handlePartyReply(
      {} as never,
      { ...input, body: 'yes' },
      deps({ familyEventId: 'event-1' }),
    );
    expect(outcome).toEqual({ status: 'ignored', reason: 'not_a_party_reply' });
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
