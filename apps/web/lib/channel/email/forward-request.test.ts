import { describe, expect, it } from 'vitest';
import { smsEncoding, smsSegments } from '~/lib/channel/sms-segments';
import {
  matchConnectorDisconnectRequest,
  matchConnectorRequest,
} from '~/lib/channel/connect/detect';
import {
  type ForwardAddressAsk,
  forwardAddressReply,
  forwardRevokeReply,
  matchForwardAddressRequest,
} from './forward-request';

/**
 * THE MATCHER, as a table — the shape connect/detect.test.ts keeps, for the same reason:
 * a claim here either hands out a credential or takes one away, so every phrasing that
 * does and does not earn one is written down rather than reasoned about.
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
});
