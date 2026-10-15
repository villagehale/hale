import { describe, expect, it, vi } from 'vitest';
import { smsSegments } from '~/lib/channel/sms-segments';
import { plainText, redactTeenNames, toSmsReply } from './reply';

/**
 * The post-processing between the model and the carrier. Everything asserted here is a
 * BACKSTOP: the skill already asks for plain, short, ASCII prose. These tests pin what
 * happens when it doesn't get one — which is the only case that matters, because the
 * model is the one part of this path that cannot be made to behave by construction.
 */

const NOW = new Date('2026-07-30T12:00:00.000Z');
const LINK = 'https://app.villagehale.com';

/** DOBs derived from the @hale/types stage boundary (teenager ≥ 156 months), against
 * NOW rather than from any code output. */
const TEEN = { name: 'Nora', gender: 'girl', dateOfBirth: '2010-03-04' };
const TODDLER = { name: 'Milo', gender: 'boy', dateOfBirth: '2024-07-30' };

describe('redactTeenNames', () => {
  it("replaces a 13+ child's first name with the generic identifier", () => {
    const out = redactTeenNames("Nora's shift moved to Thursday.", [TEEN], NOW);

    expect(out).toBe("your kid's shift moved to Thursday.");
  });

  it('leaves a under-13 child named', () => {
    const out = redactTeenNames('Milo has swim on Tuesday.', [TODDLER], NOW);

    expect(out).toBe('Milo has swim on Tuesday.');
  });

  it('matches the name case-insensitively and only on word boundaries', () => {
    const out = redactTeenNames('nora is out. Noraville is a place.', [TEEN], NOW);

    expect(out).toBe('your kid is out. Noraville is a place.');
  });

  it('ages the gate live — a child 13 next month is still named today', () => {
    const almost = { name: 'Kit', gender: 'boy', dateOfBirth: '2013-08-30' };

    expect(redactTeenNames('Kit has practice.', [almost], NOW)).toBe('Kit has practice.');
  });

  it('redacts a name whose first or last letter is accented', () => {
    const chloe = { name: 'Chloé', gender: 'girl', dateOfBirth: '2010-03-04' };
    const emile = { name: 'Émile', gender: 'boy', dateOfBirth: '2010-03-04' };

    expect(redactTeenNames('Chloé has practice Thursday.', [chloe], NOW)).toBe(
      'your kid has practice Thursday.',
    );
    expect(redactTeenNames('Practice is with Chloé.', [chloe], NOW)).toBe(
      'Practice is with your kid.',
    );
    expect(redactTeenNames('Émile is out.', [emile], NOW)).toBe('your kid is out.');
  });

  it('still stops at the whole name when the boundary is an accented letter', () => {
    const lea = { name: 'Léa', gender: 'girl', dateOfBirth: '2010-03-04' };
    const leana = { name: 'Léana', gender: 'girl', dateOfBirth: '2021-03-04' };

    expect(redactTeenNames('Léana is with Léa on Thursday.', [lea, leana], NOW)).toBe(
      'Léana is with your kid on Thursday.',
    );
  });
});

describe('toSmsReply', () => {
  it('keeps an official URL once when it already appears before other facts', () => {
    const sourceUrl = 'https://www.king.ca/recreation';
    const raw = `Source: ${sourceUrl}. Opening time is not published.`;
    const reply = toSmsReply(raw, { children: [], now: NOW, sourceUrl });
    expect(reply.split(sourceUrl)).toHaveLength(2);
    expect(reply).toContain('Opening time is not published.');
  });

  it('deduplicates each complete source URL without dropping other watches', () => {
    const urls = ['https://www.king.ca/recreation', 'https://www.richmondhill.ca/recreation'];
    const reply = toSmsReply(`Sources: ${urls[0]} ${urls[1]} ${urls[0]}`, {
      children: [],
      now: NOW,
      sourceUrl: `${urls.join(' ')} ${urls[1]}`,
    });
    for (const url of urls) expect(reply.split(url)).toHaveLength(2);
  });

  it.each(['?cycle=2027', '#aquatics', '/schedule', '.pdf'])(
    'keeps a different complete URL sharing the source prefix: %s',
    (tail) => {
      const sourceUrl = 'https://www.king.ca/recreation';
      const different = `${sourceUrl}${tail}`;
      expect(toSmsReply(`See ${different}.`, { children: [], now: NOW, sourceUrl })).toBe(
        `See ${different}. ${sourceUrl}`,
      );
    },
  );

  it('keeps a completely identical standalone eligibility statement once', () => {
    const registrationCaveat = 'King: 2026-12-07; resident/non-resident eligibility unconfirmed.';
    const raw = `${registrationCaveat} ${registrationCaveat} Non-residents open December 11.`;
    const reply = toSmsReply(raw, { children: [], now: NOW, registrationCaveat });
    expect(reply).toBe(`Non-residents open December 11. ${registrationCaveat}`);
  });

  it('does not merge differently worded eligibility warnings', () => {
    const raw = 'The page does not specify who can register on December 7.';
    const registrationCaveat = 'King: 2026-12-07; resident/non-resident eligibility unconfirmed.';
    expect(toSmsReply(raw, { children: [], now: NOW, registrationCaveat })).toBe(
      `${raw} ${registrationCaveat}`,
    );
  });

  it('does not treat an exact warning embedded in another statement as a standalone caveat', () => {
    const registrationCaveat = 'Resident/non-resident eligibility unconfirmed.';
    const raw = `Do not assume the opposite of: ${registrationCaveat} Check the official page.`;
    expect(toSmsReply(raw, { children: [], now: NOW, registrationCaveat })).toBe(
      `${raw} ${registrationCaveat}`,
    );
  });
  it.each(['A complete registration fact. ', 'A Łucas session is available. '])(
    'preserves a long answer and its protected facts without a segment cap: %s',
    (sentence) => {
      const raw = sentence.repeat(80).trim();
      const sourceUrl = 'https://www.king.ca/recreation';
      const registrationCaveat = 'Resident/non-resident eligibility unconfirmed.';
      const reply = toSmsReply(raw, { children: [], now: NOW, sourceUrl, registrationCaveat });

      expect(reply).toBe(`${raw} ${registrationCaveat} ${sourceUrl}`);
      expect(smsSegments(reply)).toBeGreaterThan(2);
    },
  );
  it('keeps uncertainty and a long held-source URL whole even when extra segments are needed', () => {
    const sourceUrl = `https://king.ca/registration/${'a'.repeat(280)}`;
    const reply = toSmsReply("I couldn't verify the current date. Please check the source.", {
      children: [],
      now: NOW,
      sourceUrl,
    });
    expect(reply).toBe(`I couldn't verify the current date. Please check the source. ${sourceUrl}`);
  });
  it('preserves an unverified answer and its source link in full', () => {
    const sourceUrl = 'https://www.king.ca/recreation';
    const raw =
      `I couldn't verify the current date. ${'Please check the official page for the latest information. '.repeat(8)}`.trim();
    const reply = toSmsReply(raw, { children: [], now: NOW, sourceUrl });
    expect(reply).toBe(`${raw} ${sourceUrl}`);
  });

  it.each(['omitted', 'included', 'long'])(
    'protects a verified registration source when the model link is %s',
    (kind) => {
      const sourceUrl =
        'https://www.richmondhill.ca/en/things-to-do/Community-Recreation-Guide.aspx';
      const answer = 'Resident registration opens Nov 24, 2026 (America/Toronto).';
      const raw =
        kind === 'included'
          ? `${answer} ${sourceUrl}`
          : kind === 'long'
            ? `${answer} ${'Please check the official page for the latest information. '.repeat(8)}`
            : answer;
      const reply = toSmsReply(raw, { children: [], now: NOW, sourceUrl });
      expect(reply).toContain('Nov 24, 2026');
      expect(reply.endsWith(sourceUrl)).toBe(true);
      expect(reply.split(sourceUrl)).toHaveLength(2);
      expect(reply).toBe(`${kind === 'included' ? answer : raw.trim()} ${sourceUrl}`);
    },
  );

  it('strips markdown the phone would render literally', () => {
    const raw = '**Two swims** this week:\n\n- Mon 4:30\n- Thu 5:15\n\nWhich one?';

    const out = toSmsReply(raw, { children: [], now: NOW });

    expect(out).toBe('Two swims this week: Mon 4:30 Thu 5:15 Which one?');
  });

  it('transliterates the characters that would flip the message to UCS-2', () => {
    const raw = 'Move swim to Tue 4:30 — it’s free then. YES to confirm.';

    const out = toSmsReply(raw, { children: [], now: NOW });

    expect(out).toBe("Move swim to Tue 4:30 - it's free then. YES to confirm.");
    expect(smsSegments(out)).toBe(1);
  });

  it('redacts a teen name before the body ever reaches the carrier', () => {
    const out = toSmsReply('Nora has practice Thursday.', {
      children: [TEEN],
      now: NOW,
    });

    expect(out).toBe('your kid has practice Thursday.');
  });

  it('leaves a short reply untouched', () => {
    const raw = 'Move swim to Tue 4:30? YES to confirm.';

    expect(toSmsReply(raw, { children: [], now: NOW })).toBe(raw);
  });

  it('keeps every sentence in a long reply, and points nowhere', () => {
    const raw = [
      'Swim is on Tuesday at four thirty and Thursday at five fifteen this week.',
      'The Thursday one is at the east pool rather than the usual west pool.',
      'There is also a make-up class on Saturday morning if you would rather do that.',
      'Registration for the fall session opens on the fifteenth of next month.',
      'I can draft any of those changes for you to approve whenever you are ready.',
    ].join(' ');

    const out = toSmsReply(raw, { children: [], now: NOW });

    expect(smsSegments(raw)).toBeGreaterThan(2);
    expect(out).toBe(raw);
    expect(out).not.toContain(LINK);
    expect(out).not.toMatch(/\bthe app\b/i);
  });

  it('keeps the schedule and the complete find with its time, venue and attribution', () => {
    const schedule =
      'Swim is on Tuesday at four thirty and Thursday at five fifteen this week, and the ' +
      'Thursday one is at the east pool rather than the usual west pool, so give yourself ' +
      'a few extra minutes to get across town before the lesson starts.';
    const find =
      'Kids and Me drop-in runs free Thursdays 1-2:30 p.m. at Acton Library - their site ' +
      'says so.';

    const out = toSmsReply(`${schedule} ${find}`, { children: [], now: NOW });

    expect(smsSegments(out)).toBeGreaterThan(2);
    expect(out).toBe(`${schedule} ${find}`);
  });

  it('keeps a single long sentence without adding an ellipsis', () => {
    const raw = `${'swim '.repeat(80)}now`;

    const out = toSmsReply(raw, { children: [], now: NOW });

    expect(out).toBe(raw);
  });

  it('does not reject an unbroken token solely because of its length', () => {
    expect(toSmsReply('x'.repeat(400), { children: [], now: NOW })).toBe('x'.repeat(400));
  });

  it('refuses to emit an empty body', () => {
    expect(() => toSmsReply('   \n  ', { children: [], now: NOW })).toThrow(/empty/i);
  });
});

/** Historical regression: the segment cap used to remove both paid-for web finds. */
describe('a long composition', () => {
  /** Verbatim from bench-calls-adv-verify.json seq 5. Do not reflow: its length IS the
   * fixture. */
  const BENCH_SEQ5 =
    'Two things worth flagging here. Fall 2026 recreation registration opens Sep 1 at ' +
    "7:00 a.m. for Halton Hills residents (Sep 8 for everyone else) - I'm already " +
    "watching it and I'll text you the week before and again just before it opens." +
    '\n\nIn the meantime, the Town of Halton Hills lists Toddler Dance for ages 2-6, ' +
    "though their site doesn't have fall dates or pricing up yet. The Acton EarlyON on " +
    'Wallace St is free for under-sixes with drop-in play most weekday mornings - their ' +
    'site says to check the Links2Care seasonal schedule for current times.';

  /** The same turn's facts, written concisely. */
  const COMPOSED_TO_BUDGET =
    "Halton Hills fall registration opens Sep 1, 7:00 a.m. for residents and I'm on it - " +
    'meanwhile the Acton EarlyON on Wallace St is free drop-in for under-sixes, their ' +
    'site says to check the seasonal schedule.';

  it('preserves both web finds and the registration date without a trim warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const out = toSmsReply(BENCH_SEQ5, { children: [], now: NOW });

    expect(warn).not.toHaveBeenCalled();
    expect(out).toBe(BENCH_SEQ5.replace(/\s+/g, ' '));
    expect(out).toContain('Sep 1');
    expect(out).toContain('EarlyON');
    expect(out).toContain('Toddler Dance');

    warn.mockRestore();
  });

  it('carries the same two facts whole when they were written to fit', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const out = toSmsReply(COMPOSED_TO_BUDGET, { children: [], now: NOW });

    expect(out).toBe(COMPOSED_TO_BUDGET);
    expect(out).toContain('Sep 1');
    expect(out).toContain('Acton EarlyON');
    expect(warn).not.toHaveBeenCalled();

    warn.mockRestore();
  });
});

/**
 * Skill audit P0 #3 — the siren, on the path that fires when the screen breaks.
 *
 * The off-domain screen FAILS OPEN by design (screen.ts openTheGate), so on a missing
 * key, a skill-load failure or a provider outage a "she hit her head and won't stop
 * crying" walks straight past the fixed 811/911 line and into the coach, whose skill
 * then asks it for a siren of its own — one that historically named a doctor and no
 * number at all. A prompt cannot be the guarantee here. This is.
 *
 * Strict equality against the constant, never a regex: "mentions 811" is what the
 * improvised version already did. What a parent standing over a hurt child gets has to
 * be the reviewed sentence, whole, including the 911 the improvisation drops.
 */
describe('a model-written health-line number goes out as the model wrote it', () => {
  const send = (raw: string) => toSmsReply(raw, { children: [], now: NOW });

  it.each([
    ['a referral naming only the health line', 'Sounds rough - call 811 if it gets worse.'],
    ['a referral naming only emergency', 'If she is struggling to breathe, call 911 now.'],
    ['a referral wrapped in advice', 'Most bumps are fine. Watch her, and 811 can advise.'],
    ['a referral buried in a scheduling answer', 'Swim is Tuesday. Ring 811 about the rash.'],
  ])('sends %s in the model words', (_name, raw) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(send(raw)).toBe(raw);
  });

  it('says out loud that it fired, so an improvised siren is countable', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    send('Call 811 about that one.');

    expect(logged).toHaveBeenCalledTimes(1);
  });

  /** The trigger is the two numbers as whole tokens, so an ordinary week does not trip
   * it: a clock time and a phone number both carry those digits inside something else. */
  it.each([
    'Swim moved to Thursday at 9:11 and I have told the coach.',
    'The number they gave me is 647-555-0811, want me to save it?',
  ])('leaves an ordinary reply alone: %s', (raw) => {
    expect(send(raw)).toBe(raw);
  });
});

describe('the plan offer line', () => {
  const child = { name: 'Milo', gender: 'boy', dateOfBirth: '2021-05-01' };
  // Composed by the model and already gated by offer_full_plan — the runtime only
  // appends it; it does not author it.
  const OFFER_LINE = 'Want me to send the full plan?';

  it('is appended by code', () => {
    const reply = toSmsReply('Try a gradual fade over two weeks.', {
      children: [child],
      now: new Date('2026-08-12T12:00:00.000Z'),
      planOffer: OFFER_LINE,
    });

    expect(reply).toBe('Try a gradual fade over two weeks. Want me to send the full plan?');
  });

  it('keeps the full answer and the offer', () => {
    const long = `${'A gradual fade works well here. '.repeat(9)}One last background clause.`;

    const reply = toSmsReply(long, {
      children: [child],
      now: new Date('2026-08-12T12:00:00.000Z'),
      planOffer: OFFER_LINE,
    });

    expect(reply).toBe(`${long} ${OFFER_LINE}`);
  });

  it('does not append when the turn offered nothing', () => {
    const reply = toSmsReply('Cancel Thursday swim? YES to confirm.', {
      children: [child],
      now: new Date('2026-08-12T12:00:00.000Z'),
    });

    expect(reply).toBe('Cancel Thursday swim? YES to confirm.');
  });

  it('sends the offer once when the model wrote it too', () => {
    const reply = toSmsReply('Try a gradual fade over two weeks. Want me to send the full plan?', {
      children: [child],
      now: new Date('2026-08-12T12:00:00.000Z'),
      planOffer: OFFER_LINE,
    });

    expect(reply.match(/Want me to send the full plan\?/g)).toHaveLength(1);
  });

  it('sends the offer alone, unpadded, when the whole answer WAS the offer', () => {
    const reply = toSmsReply(OFFER_LINE, {
      children: [child],
      now: new Date('2026-08-12T12:00:00.000Z'),
      planOffer: OFFER_LINE,
    });

    expect(reply).toBe(OFFER_LINE);
  });
});

describe('the referral block', () => {
  const child = { name: 'Milo', gender: 'boy', dateOfBirth: '2021-05-01' };
  const teen = { name: 'Nora', gender: 'girl', dateOfBirth: '2010-03-04' };
  const now = new Date('2026-08-12T12:00:00.000Z');
  // What share_referral_link registered: the model's forwardable line, then the link the
  // RUNTIME assembled. The model never composed the URL.
  const BLOCK =
    "It's a text line that keeps the family week straight. https://www.villagehale.com/text?s=friend-0123456789ab";

  it('is appended after the answer, with the link last', () => {
    const reply = toSmsReply('Forward this to them - when they text me, that is their yes.', {
      children: [child],
      now,
      referral: BLOCK,
    });

    expect(reply).toBe(`Forward this to them - when they text me, that is their yes. ${BLOCK}`);
  });

  it('keeps the full answer and the referral link', () => {
    const long = `${'Happy to pass this along whenever you like. '.repeat(8)}One trailing clause.`;

    const reply = toSmsReply(long, { children: [child], now, referral: BLOCK });

    expect(reply).toBe(`${long} ${BLOCK}`);
  });

  it('redacts a teen name inside the forwarded line (rule #1 — a parent sends this OUT)', () => {
    // The one piece of outbound text that leaves the family. The teen floor is
    // age-derived, so it has to cover the suffix and not just the answer.
    const reply = toSmsReply('Forward this to them.', {
      children: [teen],
      now,
      referral:
        "Nora's family uses it to keep the week straight. https://www.villagehale.com/text?s=friend-0123456789ab",
    });

    expect(reply).not.toContain('Nora');
    expect(reply).toContain('https://www.villagehale.com/text?s=friend-0123456789ab');
  });

  it('does not append when the turn shared nothing', () => {
    expect(toSmsReply('Cancel Thursday swim? YES to confirm.', { children: [child], now })).toBe(
      'Cancel Thursday swim? YES to confirm.',
    );
  });
});

/**
 * THE NEARBY COUNT — Hale-composed, never seen by the model, appended after the fit.
 *
 * Every gate here fails closed, and the reason is the one the SMS coach has no other
 * defence for: this surface has no fact lint, so a count the model could reword or move
 * is a count that can end up attached to the wrong activity.
 */
describe('the nearby count', () => {
  const now = new Date('2026-07-30T12:00:00.000Z');
  const NEARBY = {
    clause: '3 families near you say Riverdale storytime is worth it.',
    title: 'Riverdale storytime',
    otherTitles: ['Wychwood swim'],
  };

  it('appends it verbatim when the reply names that activity and no other', () => {
    const reply = toSmsReply('Riverdale storytime runs Saturdays at 10.', {
      children: [],
      now,
      nearby: NEARBY,
    });

    expect(reply).toBe(
      'Riverdale storytime runs Saturdays at 10. 3 families near you say Riverdale storytime is worth it.',
    );
  });

  it('says nothing when the reply names the OTHER offered activity', () => {
    const reply = toSmsReply('Wychwood swim runs Saturdays at 10.', {
      children: [],
      now,
      nearby: NEARBY,
    });

    expect(reply).toBe('Wychwood swim runs Saturdays at 10.');
  });

  it('says nothing when the reply names both — a count cannot say which it is about', () => {
    const reply = toSmsReply('Riverdale storytime is Saturday, Wychwood swim is Sunday.', {
      children: [],
      now,
      nearby: NEARBY,
    });

    expect(reply).not.toContain('families near you');
  });

  /**
   * One distinctive word is what the follow-up screen matches on, and it is the wrong
   * rule here: there a false hit costs a question, and here it puts a count about one
   * activity on a sentence about another.
   */
  it('says nothing when the reply brushes ONE word of the title', () => {
    const reply = toSmsReply('Storytime is usually at 10 on the weekend.', {
      children: [],
      now,
      nearby: NEARBY,
    });

    expect(reply).toBe('Storytime is usually at 10 on the weekend.');
  });

  it('says nothing when the reply names neither', () => {
    const reply = toSmsReply('I will look into it.', { children: [], now, nearby: NEARBY });

    expect(reply).toBe('I will look into it.');
  });

  it('keeps the full answer when appending the count exceeds two segments', () => {
    const body =
      `Riverdale storytime runs Saturdays at 10. ${'They have a craft table and a singalong too. '.repeat(5)}`.trim();
    expect(smsSegments(body)).toBeLessThanOrEqual(2);

    const reply = toSmsReply(body, { children: [], now, nearby: NEARBY });

    expect(smsSegments(reply)).toBeGreaterThan(2);
    expect(reply).toBe(`${body} ${NEARBY.clause}`);
  });

  it('appends the count without shortening a long answer', () => {
    const long =
      `Riverdale storytime runs Saturdays at 10. ${'They also have a craft table and a singalong. '.repeat(6)}`.trim();
    const reply = toSmsReply(long, { children: [], now, nearby: NEARBY });

    expect(reply).toBe(`${long} ${NEARBY.clause}`);
  });

  it('keeps the count when the only suffix is the find URL', () => {
    const reply = toSmsReply('Riverdale story time is Saturday at 10.', {
      children: [],
      now,
      nearby: {
        clause: '3 families near you say Riverdale Library is worth it.',
        title: 'Riverdale story time',
        otherTitles: [],
      },
      activityLinks: [
        {
          title: 'Riverdale story time',
          url: 'https://www.torontopubliclibrary.ca/programs-and-classes/',
          venue: 'Riverdale Library',
        },
      ],
    });

    expect(reply).toContain('3 families near you say Riverdale Library is worth it.');
    expect(reply).toContain('https://www.torontopubliclibrary.ca/programs-and-classes/');
  });

  it('still drops the count when a plan offer is the suffix', () => {
    const reply = toSmsReply('Riverdale story time is Saturday at 10.', {
      children: [],
      now,
      nearby: NEARBY,
      planOffer: 'Want me to send the full plan?',
      activityLinks: [
        {
          title: 'Riverdale story time',
          url: 'https://www.torontopubliclibrary.ca/programs-and-classes/',
        },
      ],
    });

    expect(reply).not.toContain('families near you');
    expect(reply).toContain('Want me to send the full plan?');
    expect(reply).toContain('https://www.torontopubliclibrary.ca/programs-and-classes/');
  });
});

describe('plain ASCII folding', () => {
  it('folds a non-breaking hyphen and a zero-width space so a short reply stays GSM-7', () => {
    const body = `${'Up at 2 is common at eight. '.repeat(4)}One quiet check, then back to bed\u2011same as last week.\u200b`;
    const folded = plainText(body);
    expect(folded).not.toMatch(/[\u2011\u200b]/);
    expect(smsSegments(folded)).toBeLessThanOrEqual(2);
    expect(smsSegments(body)).toBeGreaterThan(2);
  });
});

describe('activity links', () => {
  it('appends the page for the activity the reply named, and not one it did not', () => {
    const reply = toSmsReply('Fanous lantern craft is on Saturday afternoon at North York.', {
      children: [],
      now: NOW,
      activityLinks: [
        { title: 'Fanous lantern craft', url: 'https://tpl.example/lantern' },
        { title: 'Robotics workshops', url: 'https://tpl.example/robotics' },
      ],
    });
    expect(reply).toContain('https://tpl.example/lantern');
    expect(reply).not.toContain('https://tpl.example/robotics');
  });
});
