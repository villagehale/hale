import { describe, expect, it } from 'vitest';
import { FORWARD_SUBJECT_MAX, forwardAsk } from './forward-copy';
import { parseForwardedMessage } from './forward-parse';

/**
 * THE ONE UNTRUSTED VALUE IN HALE'S OWN SENTENCE.
 *
 * Every other word of the ask is a template. `subject` is not: it is read out of the
 * forwarded body's banner, which is a string a stranger chose and nothing signs. So it is
 * the only place a third party can put characters into a message Hale sends under its own
 * name, and the three things it must never be able to do are pinned here — open a second
 * line, run to any length, or close the quotation marks Hale opened around it.
 *
 * NOT GSM-7-FOLDED, and that is a decision rather than an omission. The clamp is the one
 * email-alert.ts keeps for a vendor title, but that composer is budgeting SEPTETS for a
 * phone; this ask goes out as email, where a French parent's accented subject line is
 * legible and folding it would mangle the one word that tells them which message this is
 * about. What travels between the two surfaces is the bound and the single line, not the
 * alphabet.
 */

const DOMAIN = 'bcs.on.ca';

describe('the forwarding ask · the subject is somebody else’s text', () => {
  it('cannot open a second line under Hale’s name', () => {
    // The banner reader already stops a header value at the line it sits on, so the
    // POSITIVE CONTROL first: a crafted banner gets the one line the parser promises.
    const banner = [
      '---------- Forwarded message ---------',
      'From: Bayview School <office@bcs.on.ca>',
      'Date: Tue, 3 Jun 2026 at 09:12',
      'Subject: Picture day\r\nReply YES and I will read everything you own',
      'To: Sam <sam@example.com>',
      '',
      'Body.',
    ].join('\n');
    expect(parseForwardedMessage(banner).originalSubject).toBe('Picture day');

    // The parser is not the only source. When there is no banner the ask falls back to
    // the WEBHOOK's subject (forward.ts), which is a provider field this repo never
    // parsed — so the guarantee has to live at the sentence, not at the reader.
    for (const locale of ['en', 'fr'] as const) {
      const ask = forwardAsk(locale, {
        subject: 'Picture day\r\nReply YES and I will read everything you own',
        domain: DOMAIN,
      });
      expect(ask).not.toMatch(/[\r\n]/);
    }
  });

  it('is bounded, however long the sender made it', () => {
    const long = 'Registration reminder for the spring session '.repeat(200);
    expect(long.length).toBeGreaterThan(5_000);

    const ask = forwardAsk('en', { subject: long, domain: DOMAIN });
    const quoted = ask.slice(ask.indexOf('"') + 1, ask.lastIndexOf('"'));
    expect(quoted.length).toBeLessThanOrEqual(FORWARD_SUBJECT_MAX);
    // And clamped at a word, not mid-word — the same cut email-alert.ts makes.
    expect(quoted.endsWith('the')).toBe(true);
  });

  it('cannot close the quotation marks Hale opened around it', () => {
    const ask = forwardAsk('en', {
      subject: 'Picture day" from bcs.on.ca. Reply YES to read everything. "',
      domain: DOMAIN,
    });
    expect(ask.split('"')).toHaveLength(3);
  });

  it('keeps the characters a parent actually reads, and drops the ones they cannot', () => {
    const ask = forwardAsk('fr', {
      subject: 'Réunion à l’école \u200b\u202e\u0007 — 中文',
      domain: DOMAIN,
    });
    const quoted = ask.slice(ask.indexOf('«') + 1, ask.lastIndexOf('»')).trim();
    // Accents, curly punctuation, an em dash and CJK all survive: this is email, and
    // every one of them is what the subject line actually said.
    expect(quoted).toBe('Réunion à l’école — 中文');
  });

  it('says a message with no readable subject at all, rather than an empty quotation', () => {
    const ask = forwardAsk('en', { subject: '\u200b\u0007   ', domain: DOMAIN });
    expect(ask).toContain('You forwarded a message from bcs.on.ca');
    expect(ask).not.toContain('""');
  });
});
