import { describe, expect, it } from 'vitest';
import type { EmailInboundConfig } from './config';
import { forwardAddress, forwardAnswerAddress, forwardRecipient } from './forward-address';

/**
 * THE ADDRESS IS THE CREDENTIAL, so everything that could quietly make it stop being one
 * is pinned here: the case fold the inbound parser applies to every address, the order
 * the four recipient sources are read in, and the rule that a `hale+` tag we cannot read
 * STOPS rather than falling through to the reply door.
 */

const CONFIG: EmailInboundConfig = {
  apiKey: 're_test',
  webhookSecret: 'whsec_test',
  inboundDomain: 'mail.villagehale.com',
  authservId: 'mx.resend.com',
};

const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f';
const REF = 'de adbeef'.replace(' ', '');

describe('forwardRecipient · which recipient the door reads', () => {
  it('reads the tag from data.to and returns the token', () => {
    expect(forwardRecipient({ to: [forwardAddress(TOKEN, CONFIG)], headers: {} }, CONFIG)).toEqual({
      kind: 'forward',
      token: TOKEN,
      ref: null,
    });
  });

  it('carries the .ref sub-tag through, which is what makes an answer unambiguous', () => {
    expect(
      forwardRecipient({ to: [forwardAnswerAddress(TOKEN, REF, CONFIG)], headers: {} }, CONFIG),
    ).toEqual({ kind: 'forward', token: TOKEN, ref: REF });
  });

  it('RESOLVES AN UPPERCASED LOCAL PART — the case-fold regression the hex alphabet exists for', () => {
    const shouted = `HALE+${TOKEN.toUpperCase()}@${CONFIG.inboundDomain}`;
    expect(forwardRecipient({ to: [shouted], headers: {} }, CONFIG)).toEqual({
      kind: 'forward',
      token: TOKEN,
      ref: null,
    });
  });

  it('POSITIVE CONTROL: an untagged hale@ still routes to the reply door, unchanged', () => {
    expect(
      forwardRecipient({ to: [`hale@${CONFIG.inboundDomain}`], headers: {} }, CONFIG),
    ).toEqual({ kind: 'reply' });
  });

  it('a hale+ tag that is not a well-formed token STOPS — it never falls through', () => {
    expect(
      forwardRecipient({ to: [`hale+notatoken@${CONFIG.inboundDomain}`], headers: {} }, CONFIG),
    ).toEqual({ kind: 'malformed' });
  });

  it('ignores a tag at somebody else s domain', () => {
    expect(
      forwardRecipient({ to: [`hale+${TOKEN}@evil.test`], headers: {} }, CONFIG),
    ).toEqual({ kind: 'reply' });
  });

  it('falls back to Delivered-To, then X-Forwarded-To, then the Received for clause', () => {
    const parentOnly = { to: ['Sam <sam@example.com>'] };
    expect(
      forwardRecipient(
        { ...parentOnly, headers: { 'Delivered-To': forwardAddress(TOKEN, CONFIG) } },
        CONFIG,
      ),
    ).toEqual({ kind: 'forward', token: TOKEN, ref: null });
    expect(
      forwardRecipient(
        { ...parentOnly, headers: { 'X-Forwarded-To': forwardAddress(TOKEN, CONFIG) } },
        CONFIG,
      ),
    ).toEqual({ kind: 'forward', token: TOKEN, ref: null });
    expect(
      forwardRecipient(
        {
          ...parentOnly,
          headers: {
            Received: `by 10.0.0.1 with SMTP id x; for <${forwardAddress(TOKEN, CONFIG)}>; Tue, 3 Jun 2026 09:12:00 -0400`,
          },
        },
        CONFIG,
      ),
    ).toEqual({ kind: 'forward', token: TOKEN, ref: null });
  });

  it('matches header names case-insensitively, as content.ts promises nothing about their case', () => {
    expect(
      forwardRecipient(
        { to: [], headers: { 'delivered-to': forwardAddress(TOKEN, CONFIG) } },
        CONFIG,
      ),
    ).toEqual({ kind: 'forward', token: TOKEN, ref: null });
  });

  it('the worst-case local part still parses: 5 + 30 + 1 + 8 = 44 octets, inside RFC 5321s 64', () => {
    const address = forwardAnswerAddress(TOKEN, REF, CONFIG);
    expect(address.slice(0, address.lastIndexOf('@'))).toHaveLength(44);
    expect(forwardRecipient({ to: [address], headers: {} }, CONFIG)).toEqual({
      kind: 'forward',
      token: TOKEN,
      ref: REF,
    });
  });
});
