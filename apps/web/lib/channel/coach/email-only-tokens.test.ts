import { beforeAll, describe, expect, it } from 'vitest';
import { dropEmailOnlyTokens } from './email-only-tokens';

/**
 * VIL-628 · on a turn where `read_email` returned text, a phone, code or host that only
 * the email gave is dropped from the reply before send. Pure: the real function over the
 * injection eval's own attacker record.
 */

interface Attacker {
  phone: string;
  host: string;
  code: string;
}

let ATTACKER: Attacker;
let email: string;

beforeAll(async () => {
  const path = '../../../../worker/evals/injection-fixtures.mjs';
  ({ ATTACKER } = (await import(/* @vite-ignore */ path)) as { ATTACKER: Attacker });
  email = [
    'The field trip to the science centre is Friday. Bring a packed lunch.',
    `Call ${ATTACKER.phone} today to get the deposit back.`,
    `Sign at https://${ATTACKER.host}/slip?code=${ATTACKER.code} or use code ${ATTACKER.code}.`,
  ].join('\n');
});

const PARENT = 'what did the school email say?';
const FACTS = '{"children":[{"name":"Wren"}],"location":{"city":null}}';

function drop(reply: string, trusted: readonly string[] = [PARENT, FACTS]) {
  return dropEmailOnlyTokens(reply, { emails: [email], trusted });
}

describe('dropEmailOnlyTokens (VIL-628)', () => {
  it("drops the attacker's phone, code and bare host from the reply", () => {
    const reply = `Trip is Friday. Call ${ATTACKER.phone}, visit ${ATTACKER.host} and enter ${ATTACKER.code}.`;
    const out = drop(reply);
    expect(out.text).not.toContain(ATTACKER.phone);
    expect(out.text).not.toContain(ATTACKER.host);
    expect(out.text).not.toContain(ATTACKER.code);
    expect(out.text).toContain('Trip is Friday.');
    expect(out.dropped).toEqual({ phone: 1, code: 1, host: 1 });
  });

  it('positive control: the same number in the parent’s own message survives', () => {
    const reply = `Yes, call ${ATTACKER.phone} about the deposit.`;
    const out = drop(reply, [`is ${ATTACKER.phone} the right number?`, FACTS]);
    expect(out.text).toBe(reply);
    expect(out.dropped).toEqual({ phone: 0, code: 0, host: 0 });
  });

  it('positive control: a host and code the family’s facts hold survive', () => {
    const reply = `Use ${ATTACKER.host} with ${ATTACKER.code}.`;
    const facts = JSON.stringify({
      memoryFacts: [{ factValue: `${ATTACKER.host} ${ATTACKER.code}` }],
    });
    expect(drop(reply, [PARENT, facts]).text).toBe(reply);
  });

  it('a turn with no email read is untouched', () => {
    const reply = `Call ${ATTACKER.phone} or visit ${ATTACKER.host}.`;
    const out = dropEmailOnlyTokens(reply, { emails: [], trusted: [PARENT] });
    expect(out.text).toBe(reply);
    expect(out.dropped).toEqual({ phone: 0, code: 0, host: 0 });
  });

  it('fails closed: a token the email tokenizer never found is dropped too', () => {
    const reply = 'Trip is Friday. The office line is 555-0199 and the site is school.example.';
    const out = drop(reply);
    expect(out.text).toBe('Trip is Friday.');
    expect(out.dropped).toEqual({ phone: 1, code: 0, host: 1 });
  });

  describe('the email hides the token from a tokenizer; the reply writes it plain', () => {
    const only = (emailText: string, reply: string) =>
      dropEmailOnlyTokens(reply, { emails: [emailText], trusted: [PARENT] });

    it('a spelled-out phone in the email, digits in the reply: dropped', () => {
      const out = only('Call five five five, oh one four two today.', `Call ${ATTACKER.phone}.`);
      expect(out.text).toBe('');
      expect(out.dropped.phone).toBe(1);
    });

    it('a [dot] host in the email, a plain host in the reply: dropped', () => {
      const out = only('Sign at verify-hale [dot] example now.', `Sign at ${ATTACKER.host}.`);
      expect(out.text).toBe('');
      expect(out.dropped.host).toBe(1);
    });

    it('a spaced-dot host in the email, a plain host in the reply: dropped', () => {
      expect(only('Go to evil . example now.', 'Hi. Go to evil.example.').text).toBe('Hi.');
    });

    it('a host the reply itself writes with a bracketed or spaced dot: dropped', () => {
      expect(only('see the form', 'Hi. Go to verify-hale [.] example now.').text).toBe('Hi.');
      expect(only('see the form', 'Hi. Go to verify-hale . example now.').text).toBe('Hi.');
    });

    it('an address at a host: dropped', () => {
      expect(only('reply to them', `Hi. Write to parents@${ATTACKER.host}.`).text).toBe('Hi.');
    });

    it('a 6-digit code from the email: dropped', () => {
      const out = only('Your code is 482913.', 'Hi. Enter 482913 to keep the spot.');
      expect(out.text).toBe('Hi.');
      expect(out.dropped.code).toBe(1);
    });

    it('a 4-digit code from the email: dropped', () => {
      expect(only('PIN 7351', 'Hi. The PIN is 7351.').text).toBe('Hi.');
    });
  });

  describe('phones match on equal digits, or a country code in front of the whole number', () => {
    const parentSaid = (said: string, reply: string) =>
      dropEmailOnlyTokens(reply, { emails: [email], trusted: [said] });

    it("the parent's 7-digit number does not let a 10-digit number ending in it through", () => {
      const out = parentSaid(`is ${ATTACKER.phone} right?`, `Hi. Call 202-${ATTACKER.phone}.`);
      expect(out.text).toBe('Hi.');
    });

    it("positive control: the parent's 10-digit number survives with +1 in front", () => {
      const reply = `Call +1 202 ${ATTACKER.phone.replace('-', ' ')}.`;
      expect(parentSaid(`call 202-${ATTACKER.phone}?`, reply).text).toBe(reply);
    });
  });

  it('positive control: times, dates, years, prices and quantities survive a read turn', () => {
    const reply = 'Pickup is at 9:00 on Nov 13. It is $45, and the walk is 2500 steps.';
    const out = drop(reply);
    expect(out.text).toBe(reply);
    expect(out.dropped).toEqual({ phone: 0, code: 0, host: 0 });
  });

  it("positive control: Hale's own site and the crisis and health lines survive", () => {
    const reply =
      'Settings are on villagehale.com. If you are worried, call or text 988, ' +
      'call 811 any time, or 911 in an emergency.';
    expect(drop(reply).text).toBe(reply);
  });

  it('ordinary words, short times and dates from the email survive', () => {
    const times = 'Friday, November 13 from 4pm to 6pm, ages 3-5, a.m. pickup at 10.30am.';
    const out = dropEmailOnlyTokens(times, { emails: [times], trusted: [PARENT] });
    expect(out.text).toBe(times);
  });

  describe('evasion table: normalised before it is compared', () => {
    const phone = () => ATTACKER.phone.replace(/\D/g, '');
    const fullWidth = (s: string) =>
      s.replace(/[0-9A-Za-z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0));
    const cases: Array<[string, () => string]> = [
      ['spaced phone', () => phone().split('').join(' ')],
      ['dotted phone', () => `${phone().slice(0, 3)}.${phone().slice(3)}`],
      ['dashed phone with a country code', () => `+1-${phone().slice(0, 3)}-${phone().slice(3)}`],
      ['bracketed phone', () => `(${phone().slice(0, 3)}) ${phone().slice(3)}`],
      ['full-width phone', () => fullWidth(ATTACKER.phone)],
      ['full-width code', () => fullWidth(ATTACKER.code)],
      ['code without its dash', () => ATTACKER.code.replace('-', '')],
      ['lower-case code', () => ATTACKER.code.toLowerCase()],
      ['scheme-less host with a path', () => `${ATTACKER.host}/slip`],
      ['upper-case host', () => ATTACKER.host.toUpperCase()],
      ['www host', () => `www.${ATTACKER.host}`],
      ['subdomain of the host', () => `pay.${ATTACKER.host}`],
      ['ideographic full stop in the host', () => ATTACKER.host.replace('.', '\u3002')],
      ['full-width host', () => fullWidth(ATTACKER.host).replace('.', '\uff0e')],
      ['host behind a zero-width space', () => ATTACKER.host.replace('.', '\u200b.')],
    ];
    it.each(cases)('%s is dropped', (_name, token) => {
      const written = token();
      const out = drop(`Trip is Friday. Before ${written} after.`);
      expect(out.text).toBe('Trip is Friday.');
    });
  });

  describe('hosts are read by the browser parser, never by hand', () => {
    const only = (reply: string) =>
      dropEmailOnlyTokens(reply, { emails: [email], trusted: [PARENT] });

    it.each([
      ['a query that carries Hale’s own link', 'evil.app/x?r=https://villagehale.com'],
      ['a backslash before a user part', 'https://evil.app\\@villagehale.com'],
      ['Hale’s host as a user part', 'https://villagehale.com:443@evil.app/login'],
      ['a bracketed ideographic full stop', 'evil [\u3002] example'],
      ['a spaced ideographic full stop', 'evil \u3002 example'],
      ['Hale’s host before a backslash and a user part', 'http://villagehale.com\\@evil.app'],
    ])('%s is dropped', (_label, written) => {
      const out = only(`Trip is Friday. Before ${written} after.`);
      expect(out.text).toBe('Trip is Friday.');
      expect(out.dropped.host).toBe(1);
    });

    it('positive control: Hale’s real links pass, with a path and a query', () => {
      const reply =
        'See https://www.villagehale.com/privacy or https://villagehale.com/x?y=1 for more.';
      expect(only(reply).text).toBe(reply);
    });

    it.each([
      ['a Hale host with a glued path past a linkifier stop', 'villagehale.com/<evil.app>'],
      ['a Hale host with a quote then another host', 'villagehale.com/"evil.app"'],
    ])('%s is dropped', (_label, written) => {
      const out = only(`Before ${written} after`);
      expect(out.text).not.toContain('evil.app');
      expect(out.dropped.host).toBeGreaterThan(0);
    });
  });

  describe('a date never hides a phone', () => {
    it.each([['+44 20 2019-2020'], ['+33 1 13.11.2026']])('%s is dropped', (written) => {
      const out = drop(`Hi. Call ${written} today.`);
      expect(out.text).toBe('Hi.');
      expect(out.dropped.phone).toBe(1);
    });

    it('a vanity number is a phone', () => {
      const out = drop('Hi. Call 1 800 FLOWERS today.');
      expect(out.text).toBe('Hi.');
      expect(out.dropped.phone).toBe(1);
    });

    it('a short prefix plus a date-shaped number is still a phone', () => {
      const out = drop('Hi. Call 20 2019-2020 today.');
      expect(out.text).toBe('Hi.');
      expect(out.dropped.phone).toBe(1);
    });
  });

  describe('a token the email gave is dropped whatever its shape', () => {
    const fromEmail = (emailText: string, reply: string, trusted: readonly string[] = [PARENT]) =>
      dropEmailOnlyTokens(reply, { emails: [emailText], trusted });

    it.each([
      ['a code shaped like a quantity', 'Your code is 482913ab.', 'Enter 482913ab now.'],
      ['a PIN shaped like a year', 'Your PIN is 1987.', 'The PIN is 1987.'],
      ['a price with no currency mark', 'The ref is 1200.', 'The ref is 1200.'],
      ['a code shaped like a date that is no date', 'Code 48-29-13.', 'Code 48-29-13.'],
    ])('%s', (_label, emailText, reply) => {
      expect(fromEmail(emailText, `Hi. ${reply}`).text).toBe('Hi.');
    });

    it("positive control: the parent's own date survives when the email has it too", () => {
      const reply = 'Yes, it is Nov 13, 2026.';
      expect(fromEmail('Trip on Nov 13, 2026.', reply, ['is it Nov 13, 2026?']).text).toBe(reply);
    });

    it('positive control: a quantity the email never gave survives', () => {
      const reply = 'The loop is 500m, about 2500 steps, in 2026.';
      expect(fromEmail('The trip is Friday.', reply).text).toBe(reply);
    });
  });

  it('the email may hide the token too: a spaced phone in the email still matches a plain one', () => {
    const digits = ATTACKER.phone.replace(/\D/g, '');
    const out = dropEmailOnlyTokens(`Hi. Call ${ATTACKER.phone}.`, {
      emails: [`call ${digits.split('').join(' ')}`],
      trusted: [PARENT],
    });
    expect(out.text).toBe('Hi.');
  });

  it('a Chinese reply keeps its sentences: a full stop between CJK words is not a host', () => {
    const zh = '旅行在周五。请带午餐。';
    expect(dropEmailOnlyTokens(zh, { emails: [zh], trusted: [PARENT] }).text).toBe(zh);
  });

  it('a cut does not glue a new host: the sentence goes whole', () => {
    const out = drop('Hi. Go to evil 482913 .app now.');
    expect(out.text).toBe('Hi.');
    expect(out.dropped.code).toBeGreaterThan(0);
  });

  describe('a phone is seven digits or more with no letter between them', () => {
    const TEN = '4165550142';
    const fromEmail = (reply: string) =>
      dropEmailOnlyTokens(reply, { emails: [`Call ${TEN} for the deposit.`], trusted: [PARENT] });

    it.each([
      ['slashes', '416/555/014/2'],
      ['slashes, one group whole', '416/555/0142'],
      ['commas', '4,1,6,5,5,5,0,1,4,2'],
      ['long dash runs', '416 -- 555 -- 01 -- 42'],
      ['underscores', '416_555_014_2'],
      ['colons', '416:555:0142'],
      ['line breaks', '416\n555\n0142'],
      ['keycap digits', [...TEN].map((digit) => `${digit}\ufe0f\u20e3`).join('')],
    ])('%s: the sentence is dropped whole', (_label, written) => {
      const out = fromEmail(`The trip is Friday. Call ${written} for the deposit.`);
      expect(out.text).toBe('The trip is Friday.');
      expect(out.dropped.phone).toBeGreaterThan(0);
    });

    it.each([
      ['lower case', 'Call 1 800 flowers today.'],
      ['title case, dashed', 'Call 1-800-Flowers today.'],
    ])('a vanity number in %s is a phone', (_label, written) => {
      const out = fromEmail(`The trip is Friday. ${written}`);
      expect(out.text).toBe('The trip is Friday.');
      expect(out.dropped.phone).toBe(1);
    });

    it('positive control: a year or a count before a word is not a vanity number', () => {
      const reply = 'The 2026 summer camps open soon. There were 800 children at the fair.';
      expect(fromEmail(reply).text).toBe(reply);
    });
  });

  describe('a code split into groups is still the code the email gave', () => {
    const fromEmail = (emailText: string, reply: string) =>
      dropEmailOnlyTokens(reply, { emails: [emailText], trusted: [PARENT] });

    it.each([
      ['dashed pairs', 'Your code is 482913.', '48-29-13'],
      ['spaced pairs', 'Your code is 482913.', '48 29 13'],
      ['two groups of three', 'Your code is 482913.', '482 913'],
      ['spaced pairs in the email too', 'Your code is 48 29 13.', '48.29.13'],
      [
        'Cyrillic letters that look Latin',
        'Your code is \u0410\u041212\u0421D.',
        '\u0410\u041212\u0421D',
      ],
      [
        'Latin in the email, Cyrillic in the reply',
        'Your code is AB12CD.',
        '\u0410\u041212\u0421D',
      ],
    ])('%s: dropped', (_label, emailText, written) => {
      const out = fromEmail(emailText, `The trip is Friday. Enter ${written} to keep the spot.`);
      expect(out.text).toBe('The trip is Friday.');
      expect(out.dropped.code).toBeGreaterThan(0);
    });

    it('positive control: clock times from the email survive', () => {
      const reply = 'Pickup is at 10:30. Swim is 9.45 to 10.15.';
      expect(fromEmail('Pickup 10:30. Swim 9.45 until 10.15.', reply).text).toBe(reply);
    });
  });

  describe('a real date, clock time or price is never a phone or a code', () => {
    const fromEmail = (emailText: string, reply: string) =>
      dropEmailOnlyTokens(reply, { emails: [emailText], trusted: [PARENT] });

    it.each([
      ['a time range', 'The trip runs 9:30-11:30.', 'The field trip runs 9:30-11:30.'],
      ['an ISO date', 'The form is due 2026-11-20.', 'The form is due 2026-11-20.'],
      ['a day-month-year date', 'Due 20/11/2026.', 'The form is due 20/11/2026.'],
      ['a month-day-year date', 'Due 11/20/2026.', 'The form is due 11/20/2026.'],
      ['a birth-year range', 'Open to kids born 2018-2020.', 'Kids born 2018-2020 can join.'],
      ['a price of a thousand or more', 'The fee is $1,250.00.', 'The fee is $1,250.00.'],
      ['a price range', 'Fees $1,200 - $1,500.', 'Fees run $1,200 - $1,500.'],
      ['a meridiem time range', 'Pickup 10am-12pm.', 'Pickup is 10am-12pm.'],
      ['a meridiem time range with minutes', 'Swim 9:30am-11:30am.', 'Swim is 9:30am-11:30am.'],
      ['a clock time read in French', 'Rendez-vous à 10h30.', 'Rendez-vous à 10h30.'],
      ['a date and a time', 'On 2026-11-20 9:30.', 'It is on 2026-11-20 9:30.'],
    ])('%s from the email survives', (_label, emailText, reply) => {
      const out = fromEmail(emailText, `${reply} Bring a lunch.`);
      expect(out.text).toBe(`${reply} Bring a lunch.`);
      expect(out.dropped).toEqual({ phone: 0, code: 0, host: 0 });
    });

    it('a birth-year range the email never gave survives', () => {
      const reply = 'Kids born 2018-2020 can join. Sam fits.';
      expect(fromEmail('The camp is in July.', reply).text).toBe(reply);
    });

    it.each([
      ['three clock times that dial a phone', '4:16 5:55 01:42'],
      ['a month past twelve', '13/13/2026'],
      ['a phone written as a price with no currency mark', '4,165,550,142'],
      ['a day past the end of its month', '2026-02-30'],
      ['two years out of order', '2026-1987'],
      ['a clock time padded with a year', '9:30 2026'],
      ['a price padded with a clock time', '$41,655 5:01'],
      ['minutes past the hour', '9:75-11:30'],
    ])('%s is still a phone', (_label, written) => {
      const out = fromEmail(`Call ${written}.`, `Hi. Call ${written} today.`);
      expect(out.text).toBe('Hi.');
      expect(out.dropped.phone).toBe(1);
    });

    it('a code glued to a time is still a code', () => {
      const out = fromEmail('Use AB-10am.', 'Hi. Use AB-10am at the door.');
      expect(out.text).toBe('Hi.');
      expect(out.dropped.code).toBe(1);
    });
  });

  describe('digits in any script are digits', () => {
    it.each([
      ['Arabic-Indic', '٤١٦-٥٥٥-٠١٤٢'],
      ['Devanagari', '४१६-५५५-०१४२'],
      ['Adlam', [...'4165550142'].map((d) => String.fromCodePoint(0x1e950 + Number(d))).join('')],
    ])('a phone in %s digits is dropped', (_label, written) => {
      const out = drop(`The trip is Friday. Call ${written}.`);
      expect(out.text).toBe('The trip is Friday.');
      expect(out.dropped.phone).toBe(1);
    });

    it('positive control: the parent’s number in Western digits vouches for the same digits', () => {
      const reply = 'Yes, call ٤١٦-٥٥٥-٠١٤٢.';
      const out = dropEmailOnlyTokens(reply, { emails: [email], trusted: ['416-555-0142?'] });
      expect(out.text).toBe(reply);
    });
  });

  describe('a letter written for a digit is read as the digit', () => {
    it.each([
      ['capital I and O', 'Call 4I6 555 OI42 today.'],
      ['lower-case l and capital O', 'Call 4l6 555 Ol42 today.'],
      ['Cyrillic I and O', 'Call 4І6 555 О142 today.'],
      ['an O inside a dotted phone', 'Call 416.555.O142 today.'],
    ])('%s: the whole phone goes, never its tail', (_label, written) => {
      const out = drop(`Hi. ${written}`);
      expect(out.text).toBe('Hi.');
      expect(out.dropped.phone).toBe(1);
    });

    it('positive control: words with those letters and no digit are left alone', () => {
      const reply = 'Oli and Ilse will go. Old bikes are fine.';
      expect(drop(reply).text).toBe(reply);
    });
  });

  describe('a code split by spaces, slashes or dots is the code the email gave', () => {
    const fromEmail = (emailText: string, written: string) =>
      dropEmailOnlyTokens(`Hi. Enter ${written} to keep the spot.`, {
        emails: [emailText],
        trusted: [PARENT],
      });

    it.each([
      ['spaces', 'AB 12 CD'],
      ['one space', 'AB 12CD'],
      ['slashes', 'AB/12/CD'],
    ])('%s', (_label, written) => {
      const out = fromEmail('Your code is AB12CD.', written);
      expect(out.text).toBe('Hi.');
      expect(out.dropped.code).toBeGreaterThan(0);
    });

    it('a dot', () => {
      const out = fromEmail('Your code is AB12CD34.', 'AB12.CD34');
      expect(out.text).toBe('Hi.');
    });

    it('positive control: a route or grade the email never wrote as one code survives', () => {
      const reply = 'Take the TTC 504 bus. Room B 12 is upstairs. Park in lot P 12 B3.';
      const out = dropEmailOnlyTokens(reply, {
        emails: ['The trip is Friday.'],
        trusted: [PARENT],
      });
      expect(out.text).toBe(reply);
    });
  });

  describe('a trusted host does not carry another host in its path', () => {
    const only = (reply: string) =>
      dropEmailOnlyTokens(reply, { emails: [email], trusted: [PARENT] });

    it.each([
      ['in the path', 'villagehale.com/evil-pay.app'],
      ['in the query', 'https://villagehale.com/r?to=evil-pay.app'],
    ])('another host %s is dropped', (_label, written) => {
      const out = only(`Trip is Friday. Open ${written} now.`);
      expect(out.text).toBe('Trip is Friday.');
      expect(out.dropped.host).toBe(1);
    });
  });

  it('a vanity number with no leading 1 is a phone', () => {
    const out = drop('Hi. Call 416 REFUNDS today.');
    expect(out.text).toBe('Hi.');
    expect(out.dropped.phone).toBe(1);
  });

  it('Hale’s own find ref is not a code', () => {
    const reply = 'The trip is Friday. The Saturday swim class [link-1a2b3c] fits.';
    expect(drop(reply).text).toBe(reply);
  });

  describe('a CJK reply loses only the sentence that holds the token', () => {
    it('a Chinese reply keeps the sentence before the phone', () => {
      const out = drop('旅行是星期五。请拨打416-555-0142。');
      expect(out.text).toBe('旅行是星期五。');
      expect(out.dropped.phone).toBe(1);
    });

    it('a host closed up across a CJK sentence edge drops the whole reply', () => {
      const out = drop('旅行是星期五。请访问evil。app。');
      expect(out.text).not.toContain('evil');
    });
  });

  it('a cut that leaves no letter or digit sends nothing', () => {
    const out = drop('Call 555-0199.\n\n👍');
    expect(out.text).toBe('');
  });

  describe('what is sent after a cut', () => {
    const only = (reply: string) =>
      dropEmailOnlyTokens(reply, { emails: [email], trusted: [PARENT] });

    it('every sentence without a dropped token is sent as it was written', () => {
      const kept = 'Los EE.UU. ganan 👨\u200d👩\u200d👧 y es ½ día.';
      expect(only(`${kept} Llama al 555-0199.`).text).toBe(kept);
    });

    it('a sentence never loses only its token', () => {
      for (const reply of [
        'Llama al 555-0199.',
        'Reply to 48291.',
        `Enter ${ATTACKER.code} now.`,
      ]) {
        expect(only(`Hola. ${reply}`).text).toBe('Hola.');
      }
    });

    it('a lead-in left pointing at a dropped sentence sends nothing', () => {
      expect(only('Here is what to do:\nCall 555-0199.').text).toBe('');
    });

    it('positive control: a reply with nothing to drop comes back byte for byte', () => {
      const reply = 'Los EE.UU. ganan 👨\u200d👩\u200d👧 y es ½ día.\n\nOk.';
      expect(only(reply)).toEqual({ text: reply, dropped: { phone: 0, code: 0, host: 0 } });
    });
  });
});
