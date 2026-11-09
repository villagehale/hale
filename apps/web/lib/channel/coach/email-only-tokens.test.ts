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
    const reply = 'The office line is 555-0199 and the site is school.example.';
    const out = drop(reply);
    expect(out.text).toBe('The office line is and the site is.');
    expect(out.dropped).toEqual({ phone: 1, code: 0, host: 1 });
  });

  describe('the email hides the token from a tokenizer; the reply writes it plain', () => {
    const only = (emailText: string, reply: string) =>
      dropEmailOnlyTokens(reply, { emails: [emailText], trusted: [PARENT] });

    it('a spelled-out phone in the email, digits in the reply: dropped', () => {
      const out = only('Call five five five, oh one four two today.', `Call ${ATTACKER.phone}.`);
      expect(out.text).toBe('Call.');
      expect(out.dropped.phone).toBe(1);
    });

    it('a [dot] host in the email, a plain host in the reply: dropped', () => {
      const out = only('Sign at verify-hale [dot] example now.', `Sign at ${ATTACKER.host}.`);
      expect(out.text).toBe('Sign at.');
      expect(out.dropped.host).toBe(1);
    });

    it('a spaced-dot host in the email, a plain host in the reply: dropped', () => {
      expect(only('Go to evil . example now.', 'Go to evil.example.').text).toBe('Go to.');
    });

    it('a 6-digit code from the email: dropped', () => {
      const out = only('Your code is 482913.', 'Enter 482913 to keep the spot.');
      expect(out.text).toBe('Enter to keep the spot.');
      expect(out.dropped.code).toBe(1);
    });

    it('a 4-digit code from the email: dropped', () => {
      expect(only('PIN 7351', 'The PIN is 7351.').text).toBe('The PIN is.');
    });
  });

  describe('phones match on equal digits, or a country code in front of the whole number', () => {
    const parentSaid = (said: string, reply: string) =>
      dropEmailOnlyTokens(reply, { emails: [email], trusted: [said] });

    it("the parent's 7-digit number does not let a 10-digit number ending in it through", () => {
      const out = parentSaid(`is ${ATTACKER.phone} right?`, `Call 202-${ATTACKER.phone}.`);
      expect(out.text).toBe('Call.');
    });

    it("positive control: the parent's 10-digit number survives with +1 in front", () => {
      const reply = `Call +1 202 ${ATTACKER.phone.replace('-', ' ')}.`;
      expect(parentSaid(`call 202-${ATTACKER.phone}?`, reply).text).toBe(reply);
    });
  });

  it('positive control: times, dates, years, prices and quantities survive a read turn', () => {
    const reply =
      'Pickup is at 9:00 on Nov 13, 2026 (2026-11-13), for the 2025-2026 season. ' +
      'It is $45, or $1200 for the year, and the walk is 2500 steps.';
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

  it('ordinary words, times and dates from the email survive', () => {
    const times = 'Friday, November 13 from 4pm-6pm, ages 3-5, a.m. pickup at 10.30am.';
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
      const out = drop(`Before ${written} after`);
      expect(out.text).toBe('Before after');
    });
  });

  it('the email may hide the token too: a spaced phone in the email still matches a plain one', () => {
    const digits = ATTACKER.phone.replace(/\D/g, '');
    const out = dropEmailOnlyTokens(`Call ${ATTACKER.phone}.`, {
      emails: [`call ${digits.split('').join(' ')}`],
      trusted: [PARENT],
    });
    expect(out.text).toBe('Call.');
  });

  it('a Chinese reply keeps its sentences: a full stop between CJK words is not a host', () => {
    const zh = '旅行在周五。请带午餐。';
    expect(dropEmailOnlyTokens(zh, { emails: [zh], trusted: [PARENT] }).text).toBe(zh);
  });
});
