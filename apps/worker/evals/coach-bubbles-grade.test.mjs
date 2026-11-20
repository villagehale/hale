import { describe, expect, it } from 'vitest';
import { bubbleShapeFailures } from './coach-bubbles-grade.mjs';

describe('bubbleShapeFailures', () => {
  it('passes a set whose only page rides the last bubble', () => {
    expect(
      bubbleShapeFailures(
        ['Story time is Saturday at 10:30.', 'Want to go? https://lib.example/s'],
        {},
      ),
    ).toEqual([]);
  });

  it('fails a page address in a bubble before the last', () => {
    expect(bubbleShapeFailures(['Story time https://lib.example/s', 'Want to go?'], {})).toEqual([
      'a page address before the last bubble',
    ]);
  });

  it('fails a set longer than the case allows', () => {
    expect(bubbleShapeFailures(['Anytime.', 'Enjoy swim.'], { maxBubbles: 1 })).toEqual([
      'bubbles: 2, at most 1',
    ]);
  });

  it('fails a bubble that names someone the case says is never named', () => {
    expect(
      bubbleShapeFailures(['Drafted it.', 'Add wren to Saturday?'], { neverSays: ['Wren'] }),
    ).toEqual(['names "Wren"']);
  });

  it('fails a case whose turn never called a tool the case must call', () => {
    expect(
      bubbleShapeFailures(
        ['Nothing is up yet.', 'I will look again tomorrow.'],
        {
          mustCall: ['promise_activity_followup'],
        },
        { calls: ['search_village', 'find_activities'], offer: null },
      ),
    ).toEqual(['never called promise_activity_followup']);
    expect(
      bubbleShapeFailures(
        ['Nothing is up yet.', 'I will look again tomorrow.'],
        {
          mustCall: ['promise_activity_followup'],
        },
        { calls: ['find_activities', 'promise_activity_followup'], offer: null },
      ),
    ).toEqual([]);
  });

  it('fails an offer that is not in the last bubble, or that arrives twice', () => {
    const offer = 'Want the full sleep plan?';
    expect(
      bubbleShapeFailures(
        ['Waking at 2am is common now.', `Try one wake window less. ${offer}`],
        {},
        {
          calls: ['offer_full_plan'],
          offer,
        },
      ),
    ).toEqual([]);
    expect(
      bubbleShapeFailures(
        [`Waking at 2am is common now. ${offer}`, 'Try one wake window less.'],
        {},
        {
          calls: ['offer_full_plan'],
          offer,
        },
      ),
    ).toEqual(['the offer is not in the last bubble', 'the offer arrives twice or early']);
    expect(
      bubbleShapeFailures(
        [offer, `Try one wake window less. ${offer}`],
        {},
        {
          calls: ['offer_full_plan'],
          offer,
        },
      ),
    ).toEqual(['the offer arrives twice or early']);
  });

  it('fails an empty set and an empty bubble', () => {
    expect(bubbleShapeFailures([], {})).toEqual(['no bubble']);
    expect(bubbleShapeFailures(['Hi.', ' '], {})).toEqual(['an empty bubble']);
  });
});
