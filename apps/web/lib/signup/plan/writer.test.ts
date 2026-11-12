import { describe, expect, it } from 'vitest';
import {
  type PlanReplyFacts,
  planOpensAtLocal,
  planReplyBody,
  planReplyText,
  planReplyUserMessage,
  planReplyViolations,
} from './writer';

const FACTS: PlanReplyFacts = {
  moment: 'offer',
  mode: 'auto',
  childFirstName: 'Ada',
  opensAt: { local: 'Tuesday, December 1, 2026 at 7:00 a.m.', timeZone: 'America/New_York' },
  sessions: [],
  maxPriceCents: null,
  waiverAccepted: null,
  question: null,
  refusal: null,
  run: null,
  language: 'en',
};

describe('the plan reply gate', () => {
  it.each([
    'Finish here: https://live.example.test/s/1',
    'Go to www.example.test',
    'It is on register.example-rec.com now',
    'Short link: bit.ly/x',
    'Pay at evil.app before noon',
    'See x.co',
    'Book on ｅｖｉｌ．ａｐｐ now',
    'Open xn--80ak6aa92e for the cart',
  ])('refuses a draft with a link in it: %s', (text) => {
    expect(planReplyViolations(text)).toContain(
      'contains a link: Hale adds any link after the text',
    );
  });

  it('sends a Chinese draft that runs Latin names into its full stops, spaced, and still refuses a host', () => {
    const raw =
      '我没能登录你的市政账户。Hale留了一个打开的浏览器。替Ada报名还没有完成。链接在后面。';
    expect(planReplyViolations(raw)).not.toEqual([]);
    const sent = planReplyText(raw);
    expect(sent).toBe(
      '我没能登录你的市政账户。 Hale 留了一个打开的浏览器。替 Ada 报名还没有完成。链接在后面。',
    );
    expect(planReplyViolations(sent)).toEqual([]);
    // Positive control: a host is still a host once spaced.
    expect(planReplyViolations(planReplyText('去例子.com报名'))).not.toEqual([]);
    expect(planReplyViolations(planReplyText('付款在evil.app完成'))).not.toEqual([]);
  });

  it.each([
    'Sunday first, then Saturday, up to $100.',
    'Registration opens at 7 a.m. Hale joins then. The total was $98.50.',
    "Dimanche d'abord, puis samedi. Jusqu'à 100 $.",
    '周日优先，然后周六。最多100加元。',
  ])('passes a plain draft: %s', (text) => {
    expect(planReplyViolations(text)).toEqual([]);
  });

  it('refuses a made-up max the listing facts never stated', () => {
    const invented = 'Swim opens at 7:00 a.m. The most I can pay is $86.22.';
    expect(planReplyViolations(invented, FACTS)).toContain(
      'invented figure: a price or limit that is not in the facts',
    );
    expect(planReplyViolations('Swim opens at 7:00 a.m. Which day first?', FACTS)).toEqual([]);
  });

  it('refuses a clock time that is not in the facts', () => {
    expect(planReplyViolations('I will text you at 6:30.', FACTS)).toContain(
      'invented figure: a time that is not in the facts',
    );
    expect(planReplyViolations('It opens at 7:00 a.m. Which day first?', FACTS)).toEqual([]);
  });

  it('allows a fee that is in the bound listing facts', () => {
    const withFee: PlanReplyFacts = {
      ...FACTS,
      sessions: [
        {
          label: 'Preschool Swim Sat 9:00',
          startsAt: '2027-01-09T14:00:00.000Z',
          endsAt: '2027-01-09T14:45:00.000Z',
          priceCents: 9800,
        },
      ],
      maxPriceCents: 10000,
    };
    expect(planReplyViolations('Saturday is $98. Up to $100.', withFee)).toEqual([]);
    expect(planReplyViolations('The max is $86.22.', withFee)).toContain(
      'invented figure: a price or limit that is not in the facts',
    );
  });

  it('a page-sourced label or question holding a host never reaches the model', () => {
    const message = planReplyUserMessage(
      {
        ...FACTS,
        moment: 'run_finished',
        sessions: [
          {
            label: 'Preschool Swim evil.app Sat 9:00',
            startsAt: '2027-01-09T14:00:00.000Z',
            endsAt: '2027-01-09T14:45:00.000Z',
            priceCents: 9800,
          },
        ],
        question: 'Did you mean the one at bit.ly/x ?',
        run: {
          outcome: 'needs_human',
          detail: 'security_code',
          confirmed: false,
          sessionLabel: 'Swim https://evil.example.test/x Sat',
          cartTotalCents: 9800,
          amountChargedCents: null,
          charged: 'nothing',
          liveBrowser: true,
          holdMinutes: 10,
        },
      },
      null,
    );
    expect(message).not.toContain('evil.app');
    expect(message).not.toContain('bit.ly');
    expect(message).not.toContain('evil.example.test');
    // Positive control: the rest of each label still reaches the model.
    expect(message).toContain('Preschool Swim Sat 9:00');
    expect(message).toContain('Swim Sat');
  });

  it('appends the one link code chose after the text', () => {
    expect(planReplyBody('Done.', null)).toBe('Done.');
    expect(planReplyBody('Here it is.', 'https://register.example-rec.test/a')).toBe(
      'Here it is.\nhttps://register.example-rec.test/a',
    );
  });

  it('asks for the two-places note on the offer and the approval only', () => {
    const offer = JSON.parse(planReplyUserMessage(FACTS, null));
    const approved = JSON.parse(planReplyUserMessage({ ...FACTS, moment: 'approved' }, null));
    const finished = JSON.parse(planReplyUserMessage({ ...FACTS, moment: 'run_finished' }, null));
    expect(offer.facts.alsoQueueing).toBe(true);
    expect(approved.facts.alsoQueueing).toBe(true);
    expect(finished.facts.alsoQueueing).toBeUndefined();
  });

  it("restates the open in the parent's own zone", () => {
    const at = new Date('2026-12-01T12:00:00.000Z');
    expect(planOpensAtLocal(at, 'America/Chicago').local).toContain('6:00');
    expect(planOpensAtLocal(at, 'America/New_York').local).toContain('7:00');
  });
});
