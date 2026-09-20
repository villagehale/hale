import { describe, expect, it } from 'vitest';
import { smsEncoding, smsSegments } from '~/lib/channel/sms-segments';
import {
  matchConnectorDisconnectRequest,
  matchConnectorRequest,
} from '~/lib/channel/connect/detect';
import {
  type ForwardAddressAsk,
  forwardAddressReply,
  forwardRevokeAskReply,
  forwardRevokeDeclinedReply,
  forwardRevokeReply,
  matchForwardAddressRequest,
} from './forward-request';

/**
 * THE MATCHER, as a table — the shape connect/detect.test.ts keeps, for the same reason:
 * a claim here either hands out a credential or opens the question that takes one away,
 * so every phrasing that does and does not earn one is written down rather than reasoned
 * about.
 *
 * WHAT `turn_off` MEANS CHANGED IN ROUND 6, and the table is the place to say it. It used
 * to mean REVOKE NOW; it now means ASK FIRST (D17 — hard-to-reverse always needs an
 * unambiguous go), so the six hypotheticals below are listed as claims rather than hunted
 * out of the regex. A question nobody answers costs one text; a regex that tries to tell
 * "should I turn off my forwarding address?" from "turn off my forwarding address" is the
 * thing five rounds could not close.
 */

const ADDRESS = `hale+${'a'.repeat(30)}@mail.villagehale.com`;

const CLAIMS: ReadonlyArray<[string, ForwardAddressAsk]> = [
  ["what's my forwarding address", 'address'],
  ['forwarding address', 'address'],
  ['Can I get a forwarding address?', 'address'],
  ['send me my email forwarding address', 'address'],
  ['whats the forward address again', 'address'],
  ['what email do I forward to', 'address'],
  ['where do we forward mail to', 'address'],
  ['can you send me the forwarding address again', 'address'],
  ['quelle est mon adresse de transfert', 'address'],
  ['adresse pour transférer', 'address'],
  ['je veux mon adresse de transfert', 'address'],
  ['turn off my forwarding address', 'turn_off'],
  ['please disable the forwarding address', 'turn_off'],
  ['revoke my forwarding address', 'turn_off'],
  ['please turn off my email forwarding address', 'turn_off'],
  ['désactiver mon adresse de transfert', 'turn_off'],
  ['supprime mon adresse de transfert', 'turn_off'],
  // The six the round-5 verifier found. Each one OPENS the question now, and none of
  // them revokes anything — see forward-revoke.pglite.test.ts, which drives all six
  // through the shipped chain and reads the column back afterwards.
  ['what happens if I turn off my forwarding address?', 'turn_off'],
  ['if I turn off my forwarding address, will you still read them?', 'turn_off'],
  ["I didn't turn off my forwarding address, did the emails stop?", 'turn_off'],
  ["I'm thinking about turning off my forwarding address", 'turn_off'],
  ['should I turn off my forwarding address?', 'turn_off'],
  ['what if I turn off my forwarding address', 'turn_off'],
];

/**
 * Every one of these has to reach the coach, and the three groups are the three reasons a
 * sentence that contains the words is not this ask.
 *
 * THE FIVE BARE-WORD SENTENCES are the expensive ones: each was a live revoke before the
 * turn-off half was anchored on the whole noun. `forwarding` on its own is an ordinary
 * household word — the daycare's emails, the newsletter, the school portal — and reading
 * it as an instruction deleted a credential in answer to a sentence about somebody else's
 * inbox. The three below them ("turn off forwarding") are the honest asks that the same
 * anchor costs us: one coach turn each, which is the trade this matcher always makes.
 */
const DECLINES: readonly string[] = [
  'yes',
  'no',
  'oui',
  'can you forward this to my husband',
  'I forwarded you the school email yesterday',
  'forward the invite to grandma please',
  "what's my address",
  'send me the daycare address',
  "don't turn off my forwarding address",
  'never disable forwarding',
  "don't give me a forwarding address",
  'is the email forwarding thing working',
  // The bare word, in the sentences a parent actually writes.
  'Can you stop forwarding me these emails from the daycare',
  'Please cancel the forwarding of the newsletter to my work address',
  'I need to delete the forwarding rule in gmail, can you walk me through it',
  'Should I turn off forwarding on the school portal',
  'Can we stop the forwarding from the camp, it is too much',
  'turn off forwarding',
  'stop forwarding',
  'arretez le transfert',
  // Somebody else's address, and a sentence that is merely ABOUT one.
  'The camp said to email the forms to their forwarding address, do you have it',
  "the camp's forwarding address is different from ours",
  'my forwarding address for mail is changing next month because we are moving',
  'what email do I forward to grandma',
  // A STATEMENT, not an ask (round 6). Each of these ended at the noun and so cleared
  // every guard the asking half had — and each one MINTED a token and handed a parent a
  // credential in answer to a sentence that was telling Hale something. A request has an
  // ask shape: a question, or an imperative addressed to Hale, or the bare noun on its
  // own. A declarative never mints.
  'I already set up a canada post forwarding address.',
  'the school has a new forwarding address.',
  'We already have a forwarding address.',
  'I set up a filter to my forwarding address.',
  'Sam is asking about the forwarding address.',
  "J'ai configuré une adresse de transfert.",
];

describe('asking for the forwarding address', () => {
  it('claims exactly the asks that name the credential', () => {
    expect(CLAIMS.map(([body]) => matchForwardAddressRequest(body))).toEqual(
      CLAIMS.map(([, ask]) => ask),
    );
  });

  it('declines everything else, including both instructions that mean the opposite', () => {
    expect(DECLINES.map((body) => matchForwardAddressRequest(body))).toEqual(
      DECLINES.map(() => null),
    );
  });

  /**
   * Disjoint from the connector pair BY CONSTRUCTION, asserted over the whole table —
   * claims and declines both — rather than trusted to a reading, the same check
   * detect.test.ts makes of its own two halves. The chain runs all four matchers on every
   * turn, so a body two of them claim would make handler ORDER load-bearing, which is the
   * bug this forbids.
   */
  it('shares no body with the connector matchers, over the whole table', () => {
    const overlaps = [...CLAIMS.map(([body]) => body), ...DECLINES]
      .map((body) => ({
        body,
        claimedBy: [
          matchForwardAddressRequest(body) ? 'forward' : null,
          matchConnectorRequest(body) ? 'connect' : null,
          matchConnectorDisconnectRequest(body) ? 'disconnect' : null,
        ].filter((name) => name !== null),
      }))
      .filter(({ claimedBy }) => claimedBy.length > 1);
    expect(overlaps).toEqual([]);
  });
});

describe('what Hale texts back', () => {
  it('carries the whole address in GSM-7, inside two segments, in both languages', () => {
    for (const language of ['en', 'fr'] as const) {
      const body = forwardAddressReply(language, ADDRESS);
      expect({
        language,
        encoding: smsEncoding(body),
        segments: smsSegments(body) <= 2,
        carriesWholeAddress: body.includes(ADDRESS),
      }).toEqual({ language, encoding: 'gsm7', segments: true, carriesWholeAddress: true });
    }
    expect(forwardAddressReply('en', ADDRESS)).not.toBe(forwardAddressReply('fr', ADDRESS));
  });

  it('says the consent rule, so nobody sets up a filter thinking Hale reads everything', () => {
    expect(forwardAddressReply('en', ADDRESS)).toContain('until you say yes');
    expect(forwardAddressReply('fr', ADDRESS)).toContain('avant votre oui');
  });

  it('keeps every receipt to one GSM-7 segment, and never calls nothing a success', () => {
    for (const language of ['en', 'fr'] as const) {
      for (const outcome of ['revoked', 'not_configured'] as const) {
        const body = forwardRevokeReply(language, outcome);
        expect({ language, outcome, encoding: smsEncoding(body), one: smsSegments(body) }).toEqual({
          language,
          outcome,
          encoding: 'gsm7',
          one: 1,
        });
      }
    }
    expect(forwardRevokeReply('en', 'not_configured')).toContain('nothing to turn off');
    expect(forwardRevokeReply('fr', 'not_configured')).toContain('rien à désactiver');
  });

  it('does not claim the old address bounces, because it does not', () => {
    expect(forwardRevokeReply('en', 'revoked')).toContain('is ignored');
    expect(forwardRevokeReply('en', 'revoked')).not.toMatch(/bounce/i);
  });

  /**
   * THE CLOSING LINE TEACHES WORDS THE MATCHER HEARS (round 6).
   *
   * It used to say "Tell me any time to turn the address off." — a sentence no half of
   * this matcher reads, so a parent who did exactly what it said reached the coach. The
   * line now quotes the command, and the command is last so that a parent who copies the
   * whole line back still lands on it.
   */
  it('closes with a turn-off instruction that the turn-off half actually reads', () => {
    for (const [language, taught] of [
      ['en', 'turn off my forwarding address'],
      ['fr', 'désactiver mon adresse de transfert'],
    ] as const) {
      const reply = forwardAddressReply(language, ADDRESS);
      expect(reply).toContain(taught);
      expect(matchForwardAddressRequest(taught)).toBe('turn_off');
      // The WHOLE line, as a phone's "reply with quote" would send it back.
      const line = reply.slice(reply.lastIndexOf('. ') + 2);
      expect(matchForwardAddressRequest(line)).toBe('turn_off');
    }
  });
});

/**
 * THE CONFIRM TURN (round 6, D17). Revoking is hard to reverse — a new token is a
 * DIFFERENT address the parent has to go and re-enter in their mail filter — so the
 * turn-off half asks rather than acts, and this is the sentence it asks with.
 */
describe('the confirm ask, and the receipt for a no', () => {
  it('is one GSM-7 segment in both languages and says what would be lost', () => {
    for (const language of ['en', 'fr'] as const) {
      const body = forwardRevokeAskReply(language);
      expect({ language, encoding: smsEncoding(body), segments: smsSegments(body) }).toEqual({
        language,
        encoding: 'gsm7',
        segments: 1,
      });
    }
    expect(forwardRevokeAskReply('en')).toContain('would be ignored');
    expect(forwardRevokeAskReply('fr')).toContain('serait ignoré');
    expect(forwardRevokeAskReply('en')).not.toBe(forwardRevokeAskReply('fr'));
  });

  it('prints the keyword it is solicited on, in the language it asks in', () => {
    expect(forwardRevokeAskReply('en')).toContain('Reply YES');
    expect(forwardRevokeAskReply('fr')).toContain('OUI');
  });

  it('never claims anything happened - it is a question, not a receipt', () => {
    expect(forwardRevokeAskReply('en')).not.toMatch(/Done|is off|turned off/);
    expect(forwardRevokeAskReply('fr')).not.toMatch(/Fait|désactivée/);
  });

  it('answers a NO in one segment, and says the address is still on', () => {
    for (const language of ['en', 'fr'] as const) {
      const body = forwardRevokeDeclinedReply(language);
      expect({ language, encoding: smsEncoding(body), segments: smsSegments(body) }).toEqual({
        language,
        encoding: 'gsm7',
        segments: 1,
      });
    }
    expect(forwardRevokeDeclinedReply('en')).toContain('still on');
    expect(forwardRevokeDeclinedReply('fr')).toContain('active');
  });
});
