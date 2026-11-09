import { describe, expect, it } from 'vitest';
import {
  type PlanReplyFacts,
  planOpensAtLocal,
  planReplyBody,
  planReplyUserMessage,
  planReplyViolations,
} from './writer';

const FACTS: PlanReplyFacts = {
  moment: 'offer',
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
  ])('refuses a draft with a link in it: %s', (text) => {
    expect(planReplyViolations(text)).toContain(
      'contains a link: Hale adds any link after the text',
    );
  });

  it('passes a plain draft', () => {
    expect(planReplyViolations('Sunday first, then Saturday, up to $100.')).toEqual([]);
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
