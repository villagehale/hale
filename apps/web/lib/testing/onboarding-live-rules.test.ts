import { describe, expect, it } from 'vitest';
import {
  type LiveExpectations,
  type LiveReplay,
  liveViolations,
  p50TurnMs,
} from './onboarding-live-rules';

const LINES = [
  'Swim Kids 3 at Gellert Centre (ages 6-8) - Saturdays 11:00',
  'Beavers (ages 5-7) - Wednesdays 18:30',
];

const EXPECT: LiveExpectations = {
  mapLines: LINES,
  parentName: 'Barton',
  kidItems: ['Picture Day at Park Public School Thu Oct 8', 'Mia swim'],
  parentItems: ['1:1 with Mia Chen (Product)', 'Coffee next week? - Sebastian'],
  scheduledMust: [/swim kids/i],
  scheduledMustNot: [/beavers/i],
};

const GMAIL = 'https://app.villagehale.com/connect?t=abc&to=gmail';
const GCAL = 'https://app.villagehale.com/connect?t=def&to=gcal';

function clean(): LiveReplay {
  return {
    turns: [
      { inbound: 'hi', bubbles: ["Hey, it's Hale. What's your postal code?"], ms: 10 },
      {
        inbound: 'Seb is 1, Mia is 6',
        bubbles: [
          'Here is what is on.',
          `Worth a look.\n1. ${LINES[0]}\n2. ${LINES[1]}`,
          'What should I call you?',
        ],
        ms: 30,
      },
      { inbound: 'Barton', bubbles: [`Barton, want me to watch school email?\n${GMAIL}`], ms: 20 },
      {
        inbound: '[gmail connected]',
        bubbles: [
          'Gmail is connected. Picture Day at Park Public School is Thursday.',
          `Calendar too?\n${GCAL}`,
        ],
      },
      {
        inbound: '[calendar connected]',
        bubbles: [
          "Calendar is connected. Mia's swim runs into her party.",
          'Want any of those on your calendar as reminders?',
        ],
      },
      { inbound: 'thanks!', bubbles: [], outcome: 'handed_off' },
    ],
    parentName: 'Barton',
    kidNames: ['Sebastian', 'Mia'],
    scheduledTitles: ['Swim Kids 3 at Gellert Centre'],
  };
}

describe('liveViolations', () => {
  it('passes a correct walk, and a handed-off turn is not unanswered', () => {
    expect(liveViolations(clean(), EXPECT)).toEqual([]);
  });

  it('names an unanswered inbound', () => {
    const replay = clean();
    replay.turns[0] = { inbound: 'hi', bubbles: [] };
    expect(liveViolations(replay, EXPECT)).toEqual(['unanswered: "hi"']);
  });

  it('reads the map: every line, no question, the name ask on its own', () => {
    const replay = clean();
    replay.turns[1] = {
      inbound: 'Seb is 1, Mia is 6',
      bubbles: [`Which one?\n1. ${LINES[0]}\nWhat should I call you?`],
    };
    const out = liveViolations(replay, EXPECT);
    expect(out).toContain(`map line missing: "${LINES[1]}"`);
    expect(out).toContain('map carries a question mark');
    expect(out).toContain('map asks which one');
    expect(out).toContain('name not asked as its own message after the map');
  });

  it("refuses a kid's name stored as the parent's, and a second name ask", () => {
    const replay = clean();
    replay.parentName = 'Sebastian';
    replay.turns.push({ inbound: 'ok', bubbles: ["What's your name?"] });
    const out = liveViolations(replay, EXPECT);
    expect(out).toContain('parent name stored as "Sebastian", expected "Barton"');
    expect(out).toContain("a kid's name was stored as the parent's: Sebastian");
    expect(out).toContain('name asked again after it was given');
  });

  it('keeps the wow about the kids: a parent item is named by its own words, not a shared name', () => {
    const replay = clean();
    replay.turns[4] = {
      inbound: '[calendar connected]',
      bubbles: ['Calendar is connected. Your 1:1 with Mia Chen from Product is Tuesday.'],
    };
    const out = liveViolations(replay, EXPECT);
    expect(out).toContain(
      '[calendar connected]: names a parent item: "1:1 with Mia Chen (Product)"',
    );
    expect(out).toContain('[calendar connected]: no kid item mentioned (wow skipped)');
    // "Mia" alone is the kid's name: not evidence the parent's meeting was named.
    expect(liveViolations(clean(), EXPECT)).toEqual([]);
  });

  it('puts each link under its own ask, once', () => {
    const replay = clean();
    replay.turns[2] = { inbound: 'Barton', bubbles: [`What should I call you?\n${GMAIL}`] };
    replay.turns[3] = {
      inbound: '[gmail connected]',
      bubbles: ['Gmail is connected. Picture Day at Park Public School is Thursday.', GCAL],
    };
    replay.turns.push({ inbound: 'ok', bubbles: [`Want the calendar?\n${GCAL}`] });
    const out = liveViolations(replay, EXPECT);
    expect(out).toContain('gmail link under a name question');
    expect(out).toContain('calendar link under a Gmail ask');
    expect(out).toContain('calendar link sent 2 times');
  });

  it('refuses booking claims, false privacy claims, STOP wording and long bubbles', () => {
    const replay = clean();
    replay.turns.push({
      inbound: 'ok',
      bubbles: [
        "Done, Mia is signed up for swim. I never read your work email. Reply STOP to opt out. What's next?",
        `${'a'.repeat(229)}?`,
      ],
    });
    const out = liveViolations(replay, EXPECT);
    expect(out.some((line) => line.startsWith('booking claim:'))).toBe(true);
    expect(out.some((line) => line.startsWith('false privacy claim:'))).toBe(true);
    expect(out.some((line) => line.startsWith('STOP wording:'))).toBe(true);
    expect(out.some((line) => line.startsWith('bubble over 220 chars (230)'))).toBe(true);
  });

  it('wants the company named when they ask who this is, and the right lines scheduled', () => {
    const replay = clean();
    replay.turns.push({
      inbound: 'who is this?',
      bubbles: ["It's Hale. What's your postal code?"],
    });
    replay.scheduledTitles = ['Beavers'];
    const out = liveViolations(replay, EXPECT);
    expect(out).toContain('who-is-this answered without naming the company');
    expect(out).toContain('schedule missing /swim kids/i');
    expect(out).toContain('schedule wrote the wrong line /beavers/i');
  });
});

describe('p50TurnMs', () => {
  it('is the median of the measured turns, null when nothing was measured', () => {
    expect(
      p50TurnMs([
        { inbound: 'a', bubbles: [], ms: 30 },
        { inbound: 'b', bubbles: [], ms: 10 },
        { inbound: 'c', bubbles: [] },
      ]),
    ).toBe(30);
    expect(p50TurnMs([{ inbound: 'a', bubbles: [] }])).toBeNull();
  });
});
