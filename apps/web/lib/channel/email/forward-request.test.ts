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
  ['quelle est mon adresse de transfert', 'address'],
  ['adresse pour transférer', 'address'],
  ['turn off my forwarding address', 'turn_off'],
  ['turn off forwarding', 'turn_off'],
  ['please disable the forwarding address', 'turn_off'],
  ['stop forwarding', 'turn_off'],
  ['revoke my forwarding address', 'turn_off'],
  ['désactiver mon adresse de transfert', 'turn_off'],
  ['arretez le transfert', 'turn_off'],
];

/** Every one of these has to reach the coach. The first four are the expensive misses:
 * ordinary family talk that happens to contain the verb, and the two instructions that
 * mean the OPPOSITE of what the word in them looks like. */
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
   * Disjoint from the connector pair BY CONSTRUCTION, asserted over the whole table
   * rather than trusted to a reading — the same check detect.test.ts makes of its own two
   * halves. The chain runs all four matchers on every turn, so a body two of them claim
   * would make handler ORDER load-bearing, which is the bug this forbids.
   */
  it('shares no body with the connector matchers', () => {
    for (const [body] of CLAIMS) {
      expect({ body, connect: matchConnectorRequest(body) }).toEqual({ body, connect: null });
      expect({ body, disconnect: matchConnectorDisconnectRequest(body) }).toEqual({
        body,
        disconnect: null,
      });
    }
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
