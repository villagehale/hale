import { describe, expect, it } from 'vitest';
import { readAffirmative } from '~/lib/channel/affirmative';
import {
  type PartyReplyDeps,
  handlePartyReply,
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

/**
 * VIL-265 — the confirm branch IS the shared reading, not a private list that agrees
 * with it today.
 *
 * M10 held its own twelve words. WS4 had already shown what a second list costs: M6's
 * narrower copy read "yes please" as unclear and let caregiver invites lapse, silently.
 * The assertion is therefore an EQUIVALENCE over a mixed corpus rather than a list of
 * accepted words — a phrase added to (or dropped from) `lib/channel/affirmative.ts`
 * changes both readings at once, and a word re-privatised here fails immediately.
 */
describe('matchPartyLinkConfirm is the shared affirmative vocabulary', () => {
  const CORPUS = [
    // the shared vocabulary, including the words M10's private list never held
    'yes',
    'yeah',
    'ok',
    'k',
    'sure',
    'confirm',
    'approve',
    'do it',
    'go ahead',
    'go for it',
    'sounds good',
    'looks good',
    'that works',
    'works for me',
    'yes please',
    'ok thanks',
    '👍',
    '✅',
    // refusals and ordinary conversation, which must read the same on both sides
    'no',
    'nope',
    'no thanks',
    'skip',
    'never mind',
    'yes to the swim class not the party',
    'yesterday was better',
    "who's coming",
    'cancel the party',
    '',
  ];

  it.each(CORPUS)('%s', (body) => {
    expect({ body, confirms: matchPartyLinkConfirm(body) }).toEqual({
      body,
      confirms: readAffirmative(body) === 'yes',
    });
  });

  it('no longer treats a bare courtesy as authorisation to publish', () => {
    // "please" is FILLER in the shared grammar — it is stripped from either end so that
    // "yes please" is a yes, which leaves a message that is only filler carrying no
    // instruction at all. M10's private list accepted it, and it was the one word that
    // could publish a family's address off a message that never said to. Declining it
    // is not silence: the router hands an unmatched body to the conversational layer.
    expect(matchPartyLinkConfirm('please')).toBe(false);
    expect(matchPartyLinkConfirm('thanks')).toBe(false);
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

  it('mints nothing when no offer is open, however clearly the parent said yes', async () => {
    for (const body of ['yes', 'go ahead', 'sounds good', '👍']) {
      const outcome = await handlePartyReply({} as never, { ...input, body }, deps(null));
      expect({ body, outcome }).toEqual({
        body,
        outcome: { status: 'ignored', reason: 'no_pending_offer' },
      });
    }
  });

  it('mints on the same words once an offer is live', async () => {
    for (const body of ['yes', 'go ahead', 'sounds good', '👍']) {
      const outcome = await handlePartyReply(
        {} as never,
        { ...input, body },
        deps({ familyEventId: 'event-1' }),
      );
      expect({ body, status: outcome.status }).toEqual({ body, status: 'link_minted' });
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
