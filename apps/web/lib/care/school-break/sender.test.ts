import { describe, expect, it } from 'vitest';
import {
  type MessageHeaders,
  alignedSenderHost,
  fromDomainOf,
  parseAuthenticationResults,
  registrableDomain,
} from './sender';

/** Gmail's own stamp, as it writes it, for a message that authenticated as `domain`. */
function gmailStamp(domain: string, over: { dkim?: string; dmarc?: string } = {}): string {
  return [
    'mx.google.com',
    `dkim=${over.dkim ?? 'pass'} header.i=@${domain} header.s=s1 header.b=AbC123`,
    `spf=pass (google.com: domain of office@${domain} designates 192.0.2.1 as permitted sender) smtp.mailfrom=office@${domain}`,
    `dmarc=${over.dmarc ?? 'pass'} (p=NONE sp=NONE dis=NONE) header.from=${domain}`,
  ].join(';\r\n       ');
}

function message(from: string, ...stamps: string[]): MessageHeaders {
  return [
    ...stamps.map((value) => ({ name: 'Authentication-Results', value })),
    { name: 'From', value: from },
  ];
}

describe('registrableDomain', () => {
  it.each([
    ['board.example', 'board.example'],
    ['mail.board.example', 'board.example'],
    ['tdsb.on.ca', 'tdsb.on.ca'],
    ['notify.someboard.on.ca', 'someboard.on.ca'],
    ['a-school.github.io', 'a-school.github.io'],
    ['www.a-school.github.io', 'a-school.github.io'],
    ['district.k12.ca.us', 'district.k12.ca.us'],
    ['a.b.ck', 'a.b.ck'],
    ['MAIL.Board.Example.', 'board.example'],
  ])('%s is %s', (host, site) => {
    expect(registrableDomain(host)).toBe(site);
  });

  it.each([
    'ca',
    'on.ca',
    'github.io',
    'blogspot.com',
    'k12.ca.us',
    'b.ck',
    'example',
    'not a host',
  ])('%s is a public or shared-hosting suffix (or no host) and names nothing', (host) => {
    expect(registrableDomain(host)).toBeNull();
  });
});

describe('fromDomainOf', () => {
  it.each([
    ['School Office <office@mail.board.example>', 'mail.board.example'],
    ['office@board.example', 'board.example'],
    ['"office@board.example" <someone@elsewhere.example>', 'elsewhere.example'],
  ])('%s is from %s', (from, domain) => {
    expect(fromDomainOf(from)).toBe(domain);
  });

  it.each(['a@b.example, c@d.example', 'no address', 'Office <>', 'x@@y.example'])(
    '%s names no single mailbox',
    (from) => {
      expect(fromDomainOf(from)).toBeNull();
    },
  );
});

describe('parseAuthenticationResults', () => {
  it('reads the authserv-id and each result with its properties, comments dropped', () => {
    const parsed = parseAuthenticationResults(gmailStamp('board.example'));
    expect(parsed.authservId).toBe('mx.google.com');
    expect(parsed.results.map((r) => `${r.method}=${r.result}`)).toEqual([
      'dkim=pass',
      'spf=pass',
      'dmarc=pass',
    ]);
    expect(parsed.results[2]?.props.get('header.from')).toBe('board.example');
  });
});

describe('alignedSenderHost', () => {
  it('names the registrable domain when Gmail says DMARC passed for the From domain', () => {
    expect(
      alignedSenderHost(
        message('Office <office@mail.board.example>', gmailStamp('mail.board.example')),
      ),
    ).toEqual({ status: 'aligned', host: 'board.example' });
  });

  it('takes a DKIM pass by a signer in the same registrable domain when there is no DMARC', () => {
    const stamp = 'mx.google.com; dkim=pass header.d=board.example header.s=s1; spf=neutral';
    expect(alignedSenderHost(message('office@news.board.example', stamp))).toEqual({
      status: 'aligned',
      host: 'board.example',
    });
  });

  it('refuses a From domain the message did not authenticate as', () => {
    // Sent through a vendor: DKIM is the vendor's, DMARC failed for the school.
    const stamp = [
      'mx.google.com',
      'dkim=pass header.i=@mailer.example header.s=s1',
      'spf=pass smtp.mailfrom=bounce@mailer.example',
      'dmarc=fail (p=NONE) header.from=board.example',
    ].join('; ');
    expect(alignedSenderHost(message('office@board.example', stamp))).toEqual({
      status: 'unaligned',
      reason: 'not_aligned',
    });
  });

  it('never reads a stamp the sender wrote below Gmail’s own', () => {
    const gmail = gmailStamp('board.example', { dkim: 'none', dmarc: 'fail' });
    const forged = gmailStamp('board.example');
    expect(alignedSenderHost(message('office@board.example', gmail, forged))).toEqual({
      status: 'unaligned',
      reason: 'not_aligned',
    });
  });

  it('never reads a stamp from another server', () => {
    const relay = gmailStamp('board.example').replace('mx.google.com', 'relay.example');
    expect(alignedSenderHost(message('office@board.example', relay))).toEqual({
      status: 'unaligned',
      reason: 'not_gmail_stamped',
    });
  });

  it('refuses a DMARC pass for a domain other than the From domain', () => {
    expect(
      alignedSenderHost(message('office@board.example', gmailStamp('other-board.example'))),
    ).toEqual({ status: 'unaligned', reason: 'not_aligned' });
  });

  it('names no school for a shared-hosting suffix, even authenticated', () => {
    expect(alignedSenderHost(message('noreply@blogspot.com', gmailStamp('blogspot.com')))).toEqual({
      status: 'unaligned',
      reason: 'not_registrable',
    });
  });

  it('refuses a message with two From headers', () => {
    const headers = [
      ...message('office@board.example', gmailStamp('board.example')),
      { name: 'From', value: 'other@elsewhere.example' },
    ];
    expect(alignedSenderHost(headers)).toEqual({ status: 'unaligned', reason: 'no_from' });
  });
});

describe('alignedSenderHost, against text the sender controls inside Gmail’s own stamp', () => {
  /** Gmail's real verdict for a message from evil.example claiming board.example. */
  const realFail = 'dmarc=fail (p=NONE sp=NONE dis=NONE) header.from=board.example';

  it.each([
    [
      'a quoted local part in smtp.mailfrom carrying ";dmarc=pass"',
      `mx.google.com; spf=pass smtp.mailfrom="x;dmarc=pass.header.from=board.example"@evil.example; ${realFail}`,
    ],
    [
      'a quoted local part spelling a whole dmarc pass',
      `mx.google.com; spf=pass smtp.mailfrom="x; dmarc=pass header.from=board.example"@evil.example; ${realFail}`,
    ],
    [
      'a quoted local part in header.i spelling a dkim pass for the school',
      `mx.google.com; dkim=pass header.i="x; dkim=pass header.d=board.example"@evil.example; ${realFail}`,
    ],
    [
      'an escaped quote that a naive scanner reads as the end of the string',
      `mx.google.com; spf=pass smtp.mailfrom="x\\"; dmarc=pass header.from=board.example; y=\\""@evil.example; ${realFail}`,
    ],
    [
      'a quote inside a comment, which is comment text and opens nothing',
      `mx.google.com; spf=pass (google.com: domain of "odd designates 192.0.2.1) smtp.mailfrom="x;dmarc=pass header.from=board.example"@evil.example; ${realFail}`,
    ],
    [
      'an unterminated quote after the real verdict',
      `mx.google.com; ${realFail}; spf=pass smtp.mailfrom="x; dmarc=pass header.from=board.example`,
    ],
    [
      'a pass written inside a quoted reason',
      'mx.google.com; dmarc=fail reason="dmarc=pass header.from=board.example" header.from=board.example',
    ],
    ['a quoted result', 'mx.google.com; dmarc="pass" header.from=board.example'],
    [
      'a nested comment holding a semicolon',
      `mx.google.com; spf=pass (a (b; dmarc=pass header.from=board.example) c) smtp.mailfrom=x@evil.example; ${realFail}`,
    ],
  ])('names nothing for %s', (_case, stamp) => {
    expect(alignedSenderHost(message('office@board.example', stamp))).toMatchObject({
      status: 'unaligned',
    });
  });

  /**
   * Gmail's stamp for a message whose envelope sender is `mailfrom`: its SPF comment
   * repeats the envelope sender as given, so whatever the sender put in a quoted local
   * part lands inside that comment, unescaped.
   */
  function gmailStampFor(mailfrom: string, spf = 'pass'): string {
    return [
      'mx.google.com',
      `spf=${spf} (google.com: domain of ${mailfrom} designates 192.0.2.1 as permitted sender) smtp.mailfrom=${mailfrom}`,
      realFail,
    ].join(';\r\n       ');
  }

  it.each([
    [
      'a quoted local part that closes Gmail’s SPF comment and writes a dmarc pass',
      gmailStampFor('"x);dmarc=pass header.from=board.example;("@evil.example'),
    ],
    [
      'the same local part under an SPF softfail',
      gmailStampFor('"x);dmarc=pass header.from=board.example;("@evil.example', 'softfail'),
    ],
    [
      'a quoted local part that closes Gmail’s SPF comment and writes a dkim pass',
      gmailStampFor('"x);dkim=pass header.d=board.example;("@evil.example'),
    ],
    [
      'two dmarc results for one message, the pass first',
      'mx.google.com; dmarc=pass header.from=board.example; dmarc=fail header.from=board.example',
    ],
    [
      'two dmarc results for one message, the fail first',
      'mx.google.com; dmarc=fail header.from=board.example; dmarc=pass header.from=board.example',
    ],
    [
      'a quoted header.from (a quote anywhere in the stamp names nothing)',
      'mx.google.com; dmarc=pass header.from="board.example"',
    ],
    [
      'a real pass after a quoted local part that holds a semicolon',
      'mx.google.com; spf=pass smtp.mailfrom="o;ffice"@board.example; dmarc=pass header.from=board.example',
    ],
    [
      'a real pass after a comment that holds a quote',
      'mx.google.com; spf=pass (google.com: "odd) smtp.mailfrom=x@board.example; dmarc=pass header.from=board.example',
    ],
  ])('names nothing for %s, fail closed', (_case, stamp) => {
    expect(alignedSenderHost(message('office@board.example', stamp))).toEqual({
      status: 'unaligned',
      reason: 'ambiguous_stamp',
    });
  });

  it.each([
    ['Gmail’s plain stamp', gmailStamp('board.example')],
    [
      'Gmail’s stamp with its SPF comment for a plain envelope sender',
      gmailStampFor('bounce+a1=b2@board.example').replace(
        realFail,
        'dmarc=pass (p=NONE) header.from=board.example',
      ),
    ],
    [
      'two dkim results, the vendor’s failing and the school’s passing',
      'mx.google.com; dkim=fail header.d=mailer.example header.s=s1; dkim=pass header.d=board.example header.s=s2; spf=neutral',
    ],
  ])('still names the school for %s (positive control)', (_case, stamp) => {
    expect(alignedSenderHost(message('office@board.example', stamp))).toEqual({
      status: 'aligned',
      host: 'board.example',
    });
  });
});
