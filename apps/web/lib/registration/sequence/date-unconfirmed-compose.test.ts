import { describe, expect, it } from 'vitest';
import { dateUnconfirmedBody, dateUnconfirmedRefusals } from './date-unconfirmed-compose';

const LINK = 'https://rec.example.org/springfield';

describe('VIL-423 · dateUnconfirmedRefusals: the writer is handed no link, so any link is refused', () => {
  it('refuses an empty draft', () => {
    expect(dateUnconfirmedRefusals('  ')).toEqual(['empty']);
  });

  it.each([
    // Under the old prefix test this passed: it starts with a path-less facts.link.
    'I could not confirm the date. Check https://rec.example.org.evil.com/x',
    `Check the page: ${LINK}`,
    'Check bit.ly/x for the date.',
    'Details at evil.app',
    'Details at EVIL.IO/register',
    'See www.example.org',
    'Details at evil．app',
    'Details at ev​il.app',
  ])('refuses a link shape: %s', (text) => {
    expect(dateUnconfirmedRefusals(text)).toEqual(['link']);
  });

  it.each([
    "I couldn't confirm when Springfield fall swim opens on the page. Can you check it below?",
    'Je n’ai pas pu confirmer la date sur la page, e.g. vérifie-la ci-dessous. Il est 10.30am.',
    'It is 7:00 p.m. now, St. Mary’s pool page did not show the date.',
  ])('passes a plain draft: %s', (text) => {
    expect(dateUnconfirmedRefusals(text)).toEqual([]);
  });
});

describe('VIL-423 · dateUnconfirmedBody: code appends the link', () => {
  it('puts the link once, on its own line, after the text', () => {
    const body = dateUnconfirmedBody('  Check the page below.  ', LINK);
    expect(body).toBe(`Check the page below.\n${LINK}`);
    expect(body.split(LINK)).toHaveLength(2);
  });
});
