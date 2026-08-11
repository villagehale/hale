import { describe, expect, it } from 'vitest';
import { extractReply } from './reply-extract';

/**
 * Fixtures are transcribed from what the real clients actually emit into `text/plain`,
 * not from what this module happens to produce. Every assertion names the exact turn a
 * parent typed, because the failure this file exists to prevent is a leftover quote —
 * and a leftover quote still "looks like text", so a loose assertion would pass.
 *
 * Whitespace-significant fixtures are built with `join('\n')` so that a trailing space
 * (RFC 3676's delimiter is dash-dash-SPACE) survives editors and formatters.
 */

describe('extractReply · a body with nothing to strip', () => {
  it('returns the text unchanged and reports no strippers', () => {
    const result = extractReply('Two kids, 3 and 6. Tuesday at 4pm works.');
    expect(result.text).toBe('Two kids, 3 and 6. Tuesday at 4pm works.');
    expect(result.stripped).toEqual([]);
  });
});

describe('extractReply · top-posting', () => {
  it('cuts a Gmail English attribution and its quoted run', () => {
    const result = extractReply(
      [
        'Tuesday works better for the assessment — 4pm if you have it.',
        '',
        'On Mon, Aug 10, 2026 at 4:12 PM Hale <aloha@villagehale.com> wrote:',
        '',
        '> Hi Barton — the Lakeshore assessment has two slots left this week.',
        '> Reply with a day and I will hold one.',
        '>',
        '> — Hale',
      ].join('\n'),
    );
    expect(result.text).toBe('Tuesday works better for the assessment — 4pm if you have it.');
    expect(result.stripped).toEqual(['quote_header_split', 'quoted_lines', 'trailing_blank']);
  });

  it('cuts a Gmail attribution that wrapped, leaving "wrote:" on its own line', () => {
    const result = extractReply(
      [
        'Sounds good.',
        '',
        'On Mon, Aug 10, 2026 at 4:12 PM Hale <aloha@villagehale.com>',
        'wrote:',
        '> Reply with a day and I will hold one.',
      ].join('\n'),
    );
    expect(result.text).toBe('Sounds good.');
    expect(result.stripped).toEqual(['quote_header_split', 'quoted_lines', 'trailing_blank']);
  });

  it('cuts an Apple Mail attribution', () => {
    const result = extractReply(
      [
        'Wednesday, please.',
        '',
        'On Aug 10, 2026, at 4:12 PM, Hale <aloha@villagehale.com> wrote:',
        '',
        '> Reply with a day and I will hold one.',
      ].join('\n'),
    );
    expect(result.text).toBe('Wednesday, please.');
    expect(result.stripped).toEqual(['quote_header_split', 'quoted_lines', 'trailing_blank']);
  });

  it('cuts everything below an attribution whose quoted body is NOT >-prefixed', () => {
    const result = extractReply(
      [
        'Wednesday, please.',
        '',
        'On Aug 10, 2026, at 4:12 PM, Hale <aloha@villagehale.com> wrote:',
        '',
        'Hi Barton — the Lakeshore assessment has two slots left this week.',
        'Reply with a day and I will hold one.',
      ].join('\n'),
    );
    expect(result.text).toBe('Wednesday, please.');
    expect(result.stripped).toEqual(['quote_header_split', 'trailing_blank']);
  });

  it('cuts an Outlook -----Original Message----- block and the unprefixed body under it', () => {
    const result = extractReply(
      [
        "We'll take the 9am.",
        '',
        '-----Original Message-----',
        'From: Hale <aloha@villagehale.com>',
        'Sent: Monday, August 10, 2026 4:12 PM',
        'To: Barton Dong <barton@example.com>',
        'Subject: Two slots left at Lakeshore',
        '',
        'Hi Barton — the Lakeshore assessment has two slots left this week.',
      ].join('\n'),
    );
    expect(result.text).toBe("We'll take the 9am.");
    expect(result.stripped).toEqual(['quote_header_split', 'trailing_blank']);
  });

  it('cuts a bare Outlook header slab that has no dashed banner', () => {
    const result = extractReply(
      [
        'Both kids, please.',
        '',
        'From: Hale <aloha@villagehale.com>',
        'Sent: Monday, August 10, 2026 4:12 PM',
        'To: Barton Dong <barton@example.com>',
        'Subject: Two slots left at Lakeshore',
        '',
        'Hi Barton — two slots left this week.',
      ].join('\n'),
    );
    expect(result.text).toBe('Both kids, please.');
    expect(result.stripped).toEqual(['quote_header_split', 'trailing_blank']);
  });

  it('cuts a plain >-run, including >> nesting, with no attribution line at all', () => {
    const result = extractReply(
      [
        'Yes to both.',
        '',
        '> > Do you want the 9am or the 4pm?',
        '> Either works for us — checking with Dan.',
      ].join('\n'),
    );
    expect(result.text).toBe('Yes to both.');
    expect(result.stripped).toEqual(['quoted_lines', 'trailing_blank']);
  });

  it('handles CRLF line endings', () => {
    const result = extractReply(
      [
        'Tuesday at 4pm.',
        '',
        'On Mon, Aug 10, 2026 at 4:12 PM Hale <aloha@villagehale.com> wrote:',
        '> Reply with a day and I will hold one.',
      ].join('\r\n'),
    );
    expect(result.text).toBe('Tuesday at 4pm.');
    expect(result.stripped).toEqual(['quote_header_split', 'quoted_lines', 'trailing_blank']);
  });
});

describe('extractReply · bottom-posting', () => {
  it('returns the new turn written BELOW an attribution and its quoted run', () => {
    const result = extractReply(
      [
        'On Mon, Aug 10, 2026 at 4:12 PM Hale <aloha@villagehale.com> wrote:',
        '> Hi Barton — the Lakeshore assessment has two slots left this week.',
        '> Reply with a day and I will hold one.',
        '',
        'Tuesday at 4pm works. Both kids will come.',
      ].join('\n'),
    );
    expect(result.text).toBe('Tuesday at 4pm works. Both kids will come.');
    expect(result.stripped).toEqual(['quote_header_split', 'quoted_lines', 'trailing_blank']);
  });

  it('returns the new turn written below a bare quoted run', () => {
    const result = extractReply(
      ['> Reply with a day and I will hold one.', '', "Friday morning if that's still open."].join(
        '\n',
      ),
    );
    expect(result.text).toBe("Friday morning if that's still open.");
    expect(result.stripped).toEqual(['quoted_lines', 'trailing_blank']);
  });

  it('keeps every inline answer when the parent replied between quoted questions', () => {
    const result = extractReply(
      [
        '> Do you want the 9am or the 4pm?',
        '4pm.',
        '',
        '> Should I hold both spots?',
        'Just one.',
      ].join('\n'),
    );
    expect(result.text).toBe('4pm.\n\nJust one.');
    expect(result.stripped).toEqual(['quoted_lines']);
  });
});

describe('extractReply · signatures', () => {
  it('cuts at the RFC 3676 "-- " delimiter', () => {
    const result = extractReply(
      ['Tuesday works.', '', '-- ', 'Barton Dong', 'Village Hale'].join('\n'),
    );
    expect(result.text).toBe('Tuesday works.');
    expect(result.stripped).toEqual(['signature', 'trailing_blank']);
  });

  it('cuts a mobile sign-off', () => {
    const iphone = extractReply(['Tuesday at 4 works.', '', 'Sent from my iPhone'].join('\n'));
    expect(iphone.text).toBe('Tuesday at 4 works.');
    expect(iphone.stripped).toEqual(['signature', 'trailing_blank']);

    const outlook = extractReply(['Both kids.', '', 'Get Outlook for iOS'].join('\n'));
    expect(outlook.text).toBe('Both kids.');
    expect(outlook.stripped).toEqual(['signature', 'trailing_blank']);
  });

  it('cuts the signature that sits between the new turn and the quoted history', () => {
    const result = extractReply(
      [
        'Tuesday works.',
        '',
        '-- ',
        'Barton Dong',
        '',
        'On Mon, Aug 10, 2026 at 4:12 PM Hale <aloha@villagehale.com> wrote:',
        '> Reply with a day and I will hold one.',
      ].join('\n'),
    );
    expect(result.text).toBe('Tuesday works.');
    expect(result.stripped).toEqual([
      'quote_header_split',
      'quoted_lines',
      'signature',
      'trailing_blank',
    ]);
  });
});

describe('extractReply · forwards', () => {
  it('cuts a forwarded block and keeps the note the parent wrote above it', () => {
    const result = extractReply(
      [
        'Can you add this to the calendar?',
        '',
        '---------- Forwarded message ---------',
        'From: Lakeshore Daycare <office@lakeshore.example>',
        'Date: Mon, Aug 10, 2026 at 9:02 AM',
        'Subject: Registration opens Friday',
        'To: <barton@example.com>',
        '',
        'Registration for the fall term opens Friday at 7am.',
      ].join('\n'),
    );
    expect(result.text).toBe('Can you add this to the calendar?');
    expect(result.stripped).toEqual(['forward_block', 'trailing_blank']);
  });
});

describe('extractReply · what it must NOT strip', () => {
  it('leaves "wrote:" used mid-sentence alone', () => {
    const result = extractReply('I wrote: pick up milk. Can you remind me at 5?');
    expect(result.text).toBe('I wrote: pick up milk. Can you remind me at 5?');
    expect(result.stripped).toEqual([]);
  });

  it('leaves a line that ENDS in "wrote:" but does not open with a dated "On …"', () => {
    const result = extractReply("Here's what I wrote:\npick up milk, then the 4pm.");
    expect(result.text).toBe("Here's what I wrote:\npick up milk, then the 4pm.");
    expect(result.stripped).toEqual([]);
  });

  it('leaves an undated "On … wrote:" sentence — a real attribution always carries a date', () => {
    const result = extractReply(['On Tuesday I wrote:', 'pick up milk and the forms.'].join('\n'));
    expect(result.text).toBe('On Tuesday I wrote:\npick up milk and the forms.');
    expect(result.stripped).toEqual([]);
  });

  it('leaves a markdown-ish quote the parent typed as their whole message', () => {
    const result = extractReply('> can you resend the registration link?');
    expect(result.text).toBe('> can you resend the registration link?');
    expect(result.stripped).toEqual([]);
  });

  it('leaves "--" without the trailing space — that is prose, not a delimiter', () => {
    const result = extractReply(['Tuesday works.', '--', 'Barton'].join('\n'));
    expect(result.text).toBe('Tuesday works.\n--\nBarton');
    expect(result.stripped).toEqual([]);
  });

  it('leaves an em dash on its own line', () => {
    const result = extractReply(['Tuesday works.', '—', 'Barton'].join('\n'));
    expect(result.text).toBe('Tuesday works.\n—\nBarton');
    expect(result.stripped).toEqual([]);
  });

  it('leaves prose that mentions an email address and one header-shaped line', () => {
    const result = extractReply(
      [
        'Copy me at barton@example.com on anything from the daycare.',
        'From: the pickup list, please remove Dan.',
      ].join('\n'),
    );
    expect(result.text).toBe(
      'Copy me at barton@example.com on anything from the daycare.\n' +
        'From: the pickup list, please remove Dan.',
    );
    expect(result.stripped).toEqual([]);
  });
});

describe('extractReply · nothing but history', () => {
  it('returns an empty string when the whole body is an attribution plus its quote', () => {
    const result = extractReply(
      [
        'On Mon, Aug 10, 2026 at 4:12 PM Hale <aloha@villagehale.com> wrote:',
        '> Reply with a day and I will hold one.',
      ].join('\n'),
    );
    expect(result.text).toBe('');
    expect(result.stripped).toEqual(['quote_header_split', 'quoted_lines']);
  });

  it('returns an empty string for an empty body', () => {
    const result = extractReply('');
    expect(result.text).toBe('');
    expect(result.stripped).toEqual([]);
  });
});
