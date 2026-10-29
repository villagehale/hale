import { describe, expect, it } from 'vitest';
import { type MorningComposeInput, morningRefusals } from './morning-compose';

const FACTS: MorningComposeInput = {
  language: 'en',
  now: { date: 'Tuesday, September 15, 2026', time: '6:20 a.m.' },
  window: 'Markham Fall 2026 programs',
  portal: 'Markham ePLAY',
  link: 'https://cityofmarkham.perfectmind.com/x',
  situation: 'moved',
  had: '6:30 a.m.',
  pageShows: { date: 'Tuesday, September 15, 2026', time: '7:30 a.m.' },
};

describe('VIL-484 · morningRefusals', () => {
  it('refuses empty, a missing link and a link that was not handed', () => {
    expect(morningRefusals('  ', FACTS)).toEqual(['empty']);
    expect(morningRefusals('It moved.', FACTS)).toContain('link_missing');
    expect(morningRefusals(`${FACTS.link} https://evil.example`, FACTS)).toContain('other_link');
  });
  it('passes a text carrying the one link', () => {
    expect(morningRefusals(`Moved to 7:30. ${FACTS.link}`, FACTS)).toEqual([]);
  });
});
