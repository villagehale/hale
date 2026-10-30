import { describe, expect, it } from 'vitest';
import type { EveningComposeInput } from './evening-compose';
import { eveningRefusals } from './evening-compose';

const FACTS: EveningComposeInput = {
  language: 'en',
  now: { date: 'Monday, September 14, 2026', time: '6:00 p.m.' },
  window: 'Richmond Hill Fall 2026 recreation programs',
  who: 'your teen',
  opensAt: '6:30 a.m.',
  opensOn: 'Tuesday, September 15, 2026',
  link: 'https://www.toronto.ca/programs',
  portal: null,
  setup: null,
  situation: 'municipal',
  courseName: null,
  ageBand: null,
  children: 1,
  pageShows: null,
};

describe('evening refusals', () => {
  it('refuses an empty draft and a link that was not handed', () => {
    expect(eveningRefusals('   ', FACTS)).toEqual(['empty']);
    expect(eveningRefusals('See https://evil.example/phish tonight.', FACTS)).toEqual([
      'other_link',
    ]);
  });

  it('keeps the handed link and does not score wording', () => {
    expect(eveningRefusals('Have https://www.toronto.ca/programs open.', FACTS)).toEqual([]);
    expect(
      eveningRefusals('Tomorrow everything is booked, enrolled, and filled in.', FACTS),
    ).toEqual([]);
  });

  it('refuses any link when none was handed', () => {
    expect(eveningRefusals('https://www.toronto.ca/programs', { ...FACTS, link: null })).toEqual([
      'other_link',
    ]);
  });
});
