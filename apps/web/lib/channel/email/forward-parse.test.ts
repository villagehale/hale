import { describe, expect, it } from 'vitest';
import { parseForwardedMessage } from './forward-parse';
import { extractReply } from './reply-extract';

/**
 * THE REASON THE FORK EXISTS, asserted rather than asserted-about.
 *
 * `extractReply` hard-cuts at a forwarded-message banner, because on the reply door
 * everything below one is history Hale must not re-read as a new turn. On the forward
 * door the thing below the banner IS the message. So this parser reads the raw text, and
 * the regression at the bottom pins the behaviour it exists to route around.
 */

const GMAIL = [
  'Here you go',
  '',
  '---------- Forwarded message ---------',
  'From: Bayview School <office@bcs.on.ca>',
  'Date: Tue, 3 Jun 2026 at 09:12',
  'Subject: Spring concert',
  'To: Sam <sam@example.com>',
  '',
  'The spring concert is on June 18 at 6pm in the gym.',
].join('\n');

const APPLE = [
  'Begin forwarded message:',
  '',
  'From: Bayview School <office@bcs.on.ca>',
  'Subject: Spring concert',
  'Date: 3 June 2026 at 09:12:00 EDT',
  'To: Sam <sam@example.com>',
  '',
  'The spring concert is on June 18 at 6pm in the gym.',
].join('\n');

const OUTLOOK = [
  '-----Original Message-----',
  'From: Bayview School <office@bcs.on.ca>',
  'Sent: Tuesday, June 3, 2026 9:12 AM',
  'To: Sam <sam@example.com>',
  'Subject: Spring concert',
  '',
  'The spring concert is on June 18 at 6pm in the gym.',
].join('\n');

const BARE_SLAB = [
  'From: Bayview School <office@bcs.on.ca>',
  'Sent: Tuesday, June 3, 2026 9:12 AM',
  'To: Sam <sam@example.com>',
  'Subject: Spring concert',
  '',
  'The spring concert is on June 18 at 6pm in the gym.',
].join('\n');

const BODY = 'The spring concert is on June 18 at 6pm in the gym.';

describe('parseForwardedMessage · who really sent the document', () => {
  it.each([
    ['Gmail', GMAIL],
    ['Apple Mail', APPLE],
    ['Outlook', OUTLOOK],
    ['a bare header slab', BARE_SLAB],
  ])('reads the original sender, subject and body out of a %s forward', (_name, text) => {
    expect(parseForwardedMessage(text)).toEqual({
      originalFrom: 'office@bcs.on.ca',
      originalSubject: 'Spring concert',
      body: BODY,
    });
  });

  it('a filter auto-forward has no banner at all, so the whole text is the document', () => {
    const noBanner = 'Picture day is Thursday. Please send $12 in an envelope.';
    expect(parseForwardedMessage(noBanner)).toEqual({
      originalFrom: null,
      originalSubject: null,
      body: noBanner,
    });
  });

  it('keeps a multi-line body whole, including the blank lines inside it', () => {
    const long = `${GMAIL}\n\nRSVP by June 10.`;
    expect(parseForwardedMessage(long).body).toBe(`${BODY}\n\nRSVP by June 10.`);
  });

  it('does not mistake prose that merely names an address for a header slab', () => {
    const prose = 'Write to office@bcs.on.ca about it. From what I can tell it is on the 18th.';
    expect(parseForwardedMessage(prose)).toEqual({
      originalFrom: null,
      originalSubject: null,
      body: prose,
    });
  });

  it('REGRESSION: the same forward through extractReply is empty — the fork is not optional', () => {
    expect(extractReply(GMAIL).text).not.toContain('June 18');
    expect(extractReply(APPLE).text).toBe('');
  });
});
