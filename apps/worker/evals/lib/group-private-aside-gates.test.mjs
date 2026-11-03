import { describe, expect, it } from 'vitest';
import { GROUP_PRIVATE_ASIDE_FIXTURES } from '../group-private-aside-fixtures.mjs';
import { brokenRouter, routingFailure } from './group-private-aside-gates.mjs';

/**
 * The deterministic half of evals/run-group-private-aside-eval.mjs (VIL-457 / VIL-554):
 * the routing gate, and the over-sending router `--broken` runs it against.
 */
describe('routingFailure', () => {
  it('accepts the expected set in any order', () => {
    expect(routingFailure([['f1', 'f2']], ['f2', 'f1'])).toBeNull();
  });

  it('names the over-send #934 logged before its adjacency fix', () => {
    expect(routingFailure([['f3']], ['f1', 'f2', 'f3'])).toBe('sendTo:[f1,f2,f3] expected [f3]');
  });

  it('treats an empty set as "nobody gets a text"', () => {
    expect(routingFailure([[]], [])).toBeNull();
    expect(routingFailure([[]], ['f1'])).toBe('sendTo:[f1] expected []');
  });

  it('lists every acceptable set when none matches', () => {
    expect(routingFailure([['f1'], []], ['f2'])).toBe('sendTo:[f2] expected [f1] or []');
  });
});

describe('brokenRouter against the real fixtures', () => {
  it('fails routing on every case where texting every family is wrong', () => {
    const failing = GROUP_PRIVATE_ASIDE_FIXTURES.filter(
      (f) => routingFailure(f.sendTo, brokenRouter(f)) !== null,
    ).map((f) => f.id);
    expect(failing).toEqual([
      'en-own-card-asked-in-group',
      'en-other-family-asks-about-kid',
      'fr-clash-one-of-three',
      'zh-public-logistics',
      'en-name-in-chatter',
      'en-repeat-held-back',
      'en-real-change-sent',
    ]);
  });

  it('positive control: each case passes routing with its own expected set', () => {
    for (const f of GROUP_PRIVATE_ASIDE_FIXTURES) {
      expect(routingFailure(f.sendTo, f.sendTo[0]), f.id).toBeNull();
    }
  });
});
