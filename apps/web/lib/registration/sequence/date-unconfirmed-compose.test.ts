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
    // VIL-613 · the shared check's evasion table.
    'Details at evil。app/x',
    'Details at evil｡app/x',
    'Details at evil﹒app/x',
    'see 203.0.113.9/x',
    'Details at evil.рф',
    'Details at evil[.]app',
    'Details at bit . ly/x',
    // The format character sits before the dot, so only the \p{Cf} strip makes a host of it.
    'Details at bit\u200B.ly/x',
  ])('refuses a link shape: %s', (text) => {
    expect(dateUnconfirmedRefusals(text)).toEqual(['link']);
  });

  it.each([
    "I couldn't confirm when Springfield fall swim opens on the page. Can you check it below?",
    'Je n’ai pas pu confirmer la date sur la page, e.g. vérifie-la ci-dessous. Il est 10.30am.',
    'It is 7:00 p.m. now, St. Mary’s pool page did not show the date.',
    'I could not confirm it on the page.Check it below.',
    'The St.Mary pool page did not show it. Mr.Smith may know.',
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
