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

  it('a token the email never carried is left alone (the check is about the email)', () => {
    const reply = 'The office line is 555-0199 and the site is school.example.';
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
