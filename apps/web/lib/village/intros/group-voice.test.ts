import { describe, expect, it } from 'vitest';
import { type IntroGroupRequest, introGroupRefusals, introGroupUserMessage } from './group-voice';

const REQUEST: IntroGroupRequest = {
  parentAFirstName: 'Sam',
  parentBFirstName: 'Priya',
  stageWord: 'toddler',
  anchorTitle: 'Storytime at 10 Elm',
  anchorDay: 'Saturday',
};

const GOOD =
  "Sam, Priya - you both have a toddler and both said yes to meeting. Storytime at 10 Elm on Saturday could be an easy first hello. I'll step out and leave the thread to you.";

describe('introGroupRefusals', () => {
  it('passes an intro that names both parents and the activity', () => {
    expect(introGroupRefusals(GOOD, REQUEST)).toEqual([]);
  });

  it('refuses an intro that drops a parent or the activity', () => {
    expect(introGroupRefusals('Sam, meet a neighbour with a toddler.', REQUEST)).toEqual(
      expect.arrayContaining(['parent_name_missing', 'anchor_missing']),
    );
  });

  it('refuses a link, an address and a number it was not handed', () => {
    const problems = introGroupRefusals(
      'Sam and Priya, we found you both at 4pm - Storytime at 10 Elm, see www.x.com or a@b.co',
      REQUEST,
    );
    expect(problems).toEqual(
      expect.arrayContaining(['carries_link', 'carries_address', 'invented_number']),
    );
  });

  it('VIL-450: leaves voice to the judge model - no third-person word match', () => {
    expect(introGroupRefusals(`${GOOD} Hale will step back.`, REQUEST)).toEqual([]);
  });

  it('refuses an empty body outright', () => {
    expect(introGroupRefusals('', REQUEST)).toEqual(['empty']);
  });
});

describe('introGroupUserMessage', () => {
  it('carries exactly the five handed facts, and the refusals only on a retry', () => {
    expect(JSON.parse(introGroupUserMessage(REQUEST))).toEqual(REQUEST);
    const retry = JSON.parse(
      introGroupUserMessage(REQUEST, [{ intro: 'x', problems: ['parent_name_missing'] }]),
    );
    expect(retry.rejected).toEqual([{ intro: 'x', problems: ['parent_name_missing'] }]);
  });
});
