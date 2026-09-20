import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { impactNumbers } from '~/lib/landing/impact.js';
import { MUNICIPALITY_COUNT } from '~/lib/site/municipalities.js';
import LandingPage from './[locale]/page.js';

/**
 * villagehale.com — v5, the loop as the hero.
 *
 * v4 argued the product with two conversations (a hero exchange and a transcript
 * a screen and a half below it) and seven carded sections. v5 argues it with ONE
 * conversation on a time spine: find, watch, the morning, the receipt, the
 * evening. The page's whole claim is that Hale comes back, and the only way to
 * show elapsed time is to draw it.
 *
 * ── Where v4's negative assertions went ──────────────────────────────────────
 * `landing.test.ts` carried sixty-odd `not.` assertions and it is deleted with
 * the component it described, so each one is accounted for here rather than
 * quietly dropped. CARRIED means the same assertion, re-homed. DESIGNED OUT
 * means the defect it caught can no longer be expressed. GONE WITH ITS SECTION
 * means the copy it policed is not on the page any more.
 *
 * | v4 assertion                                     | v5          |
 * |--------------------------------------------------|-------------|
 * | no `7:02` in the h1                                | CARRIED     |
 * | no "Take the family admin off your plate"          | CARRIED     |
 * | no "Three texts, then quiet." / "then quiet"       | CARRIED     |
 * | no `!` in the hero band                            | CARRIED     |
 * | no "Message Hale"                                  | CARRIED     |
 * | no "from a real family" / "real customer" / "screenshot" | CARRIED |
 * | no question chips (4 strings + 3 class/event names)| CARRIED     |
 * | no `sms:` anchor on the landing                    | CARRIED     |
 * | no phone digits, in any grouping                   | CARRIED (T6)|
 * | no copy_number_click / "Copy number" / displaySmsNumber | CARRIED |
 * | images decorative + from the brand set only        | CARRIED     |
 * | no shore-night, no mascot art                      | CARRIED     |
 * | no signup funnel (7 hrefs and labels)              | CARRIED     |
 * | no /sign-in outside the shared chrome              | CARRIED     |
 * | no urgency around the founding rate (5 phrases)    | CARRIED     |
 * | no invented watch item (March break, PA day, summer…) | CARRIED  |
 * | no "20%" / "non-resident"                          | CARRIED     |
 * | no "The 36 hours"                                  | CARRIED     |
 * | no "You say hi" / no /no forms/i                   | CARRIED     |
 * | no "Silence is the normal state" / Monday brief    | CARRIED     |
 * | no "calendar invite"                               | CARRIED     |
 * | no "They get just the schedule"                    | CARRIED     |
 * | no "I register" / "books your spot" / "guaranteed" …| CARRIED    |
 * | no "%" / "out of 10" / "on average" in the contrast | CARRIED    |
 * | no invented signup duration, no message count       | CARRIED     |
 * | no rail tabindex/role/aria-label in server markup   | CARRIED     |
 * | no "passive household assistant" in the JSON-LD     | CARRIED     |
 * | no unwired impact metric labels                     | CARRIED     |
 * | number-unset: no dead sms:, no empty chip row       | CARRIED     |
 * | no calendar date or cycle year in the conversation  | CARRIED     |
 * | hero/transcript word-set overlap below 0.65         | DESIGNED OUT — one conversation |
 * | coaching: no "Three days later", "in three nights", "cure", "will fix" | GONE WITH ITS SECTION |
 * | with-me cell does not restate the ladder a third time | DESIGNED OUT — the ladder is told once, on the spine |
 *
 * And four negatives v4 had no reason to carry, which v5 does (T4): no travel,
 * no reviews, no Sunday brief (a SECOND flag gates that one), no emoji.
 */

const LIVE_NUMBER = '+16475551234';

async function renderLanding(number: string): Promise<string> {
  vi.stubEnv('NEXT_PUBLIC_HALE_SMS_NUMBER', number);
  const html = renderToStaticMarkup(
    await LandingPage({ params: Promise.resolve({ locale: 'en' as const }) }),
  );
  vi.unstubAllEnvs();
  return html;
}

const LIVE_HTML = await renderLanding(LIVE_NUMBER);
const EMPTY_HTML = await renderLanding('');

function render({ number = LIVE_NUMBER }: { number?: string } = {}): string {
  return number === '' ? EMPTY_HTML : LIVE_HTML;
}

function visibleText(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The loop only — the one conversation on the page. */
function loop(html: string): string {
  return html.match(/<div class="v5-loop"[\s\S]*?<\/section>/)?.[0] ?? '';
}

/** What a READER reads: the visible text with the JSON-LD graph taken out. The
 * graph is machine copy and legitimately carries words a prose scan must not
 * trip on ("operatingSystem" contains "rating"), so every absence below is
 * asserted against the page a parent sees. The graph has its own assertions. */
function prose(html: string): string {
  return visibleText(html.replace(/<script[\s\S]*?<\/script>/g, ' '));
}

afterEach(() => {
  vi.unstubAllEnvs();
});

/* ── apps/web, read as SOURCE BYTES ───────────────────────────────────────────
 * The precedent is `text-page-copy.test.ts`, which pins the /text greeting to
 * `intake/copy.ts` by regex over the file rather than by an import: the pin is a
 * byte comparison against what is written there, and a restructure THROWS rather
 * than passing vacuously. The loop makes the same promise five times over, so it
 * is held the same way. Reading rather than importing also keeps apps/site free
 * of apps/web's module graph, which is the process boundary this repo works.
 *
 * A throw here is a cross-brief signal — apps/web moved a sentence the landing
 * quotes — and never a test to loosen. */
function webSource(path: string): string {
  return readFileSync(fileURLToPath(new URL(`../../web/${path}`, import.meta.url)), 'utf8');
}

function extract(src: string, re: RegExp, what: string): string {
  const hit = re.exec(src)?.[1];
  if (hit === undefined) {
    throw new Error(`apps/web moved ${what} — read the source and re-pin the loop with it`);
  }
  return hit;
}

const SEQUENCE_COPY = webSource('lib/registration/sequence/copy.ts');
const INTAKE_COPY = webSource('lib/channel/intake/copy.ts');
const CHECKIN_COPY = webSource('lib/channel/checkin/copy.ts');
const WINDOWS_DATA = webSource('lib/registration/registration-windows-data.ts');
const TOWN_LABEL_TS = webSource('lib/channel/town-label.ts');
const SHORTLIST_TS = webSource('lib/registration/sequence/shortlist.ts');
const LEGAL_LINKS = webSource('lib/legal-links.ts');

/** The seeded window the hero's ladder is drawn from. Vaughan registers swim
 * lessons on its own date, two days after general programs, at 7 a.m. for
 * residents and 7 a.m. for everyone else — one clock, printed twice, on the
 * Town's own recreation page. */
const MUNICIPALITY = 'vaughan';
const PROGRAM_DOMAIN = 'swim';
const CHILD = 'Mia';

const ROW = extract(
  WINDOWS_DATA,
  new RegExp(
    `municipality: '${MUNICIPALITY}',\\s*programDomain: '${PROGRAM_DOMAIN}',([\\s\\S]*?)\\n\\s*\\},`,
  ),
  `the seeded ${MUNICIPALITY}/${PROGRAM_DOMAIN} window`,
);
const OPENS_AT = new Date(extract(ROW, /residentOpenAt: '([^']+)'/, 'residentOpenAt'));
const SOURCE_URL = extract(
  WINDOWS_DATA,
  new RegExp(`const ${extract(ROW, /sourceUrl: (\w+),/, 'sourceUrl')} =\\s*'([^']+)';`),
  "the row's sourceUrl constant",
);

/** `timeOfDay(anchor, timeZone)` — the same `Intl` call the two ladder legs make
 * (`en-CA`, hour + 2-digit minute, the family's zone). */
const TIME_OF_DAY = new Intl.DateTimeFormat('en-CA', {
  hour: 'numeric',
  minute: '2-digit',
  timeZone: 'America/Toronto',
}).format(OPENS_AT);
const LADDER_HOUR_24 = Number(
  new Intl.DateTimeFormat('en-CA', {
    hour: '2-digit',
    hour12: false,
    timeZone: 'America/Toronto',
  }).format(OPENS_AT),
);

/** `townLabel()` is one function with one exceptions table; anything absent from
 * the table is the token Title-Cased. Mirrored rather than imported, and the
 * table is READ, so a town that later earns an exception moves the page with it. */
const TOWN = (() => {
  const exceptions = extract(
    TOWN_LABEL_TS,
    /TOWN_LABEL_EXCEPTIONS[^=]*=\s*\{([\s\S]*?)\};/,
    'TOWN_LABEL_EXCEPTIONS',
  );
  return (
    new RegExp(`${MUNICIPALITY}: '([^']+)'`).exec(exceptions)?.[1] ??
    MUNICIPALITY.split('_')
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ')
  );
})();

/**
 * THE ONE DEPARTURE IN THE LADDER LEGS, and it is deliberate.
 *
 * `windowPhrase` is `${townLabel} ${cyclePhrase}`, and `cyclePhrase` carries the
 * published cycle NAME — "Fall Session 2026 swim lessons" — which is a dated
 * string that would make this page wrong the morning the next cycle is seeded.
 * The page prints the two halves of that phrase which cannot go stale: the town,
 * from `townLabel`, and the program, from `PROGRAM_DOMAIN_LABEL`. Both are read
 * out of apps/web here, so neither can drift; what is subtracted is the year.
 */
const PROGRAM = extract(
  SHORTLIST_TS,
  new RegExp(`PROGRAM_DOMAIN_LABEL[\\s\\S]*?${PROGRAM_DOMAIN}: '([^']+)'`),
  'PROGRAM_DOMAIN_LABEL',
);
const WINDOW_PHRASE = `${TOWN} ${PROGRAM}`;
/** Stripped of `https://www.` exactly as v4 printed a municipal link. */
const LINK = SOURCE_URL.replace(/^https:\/\/www\./, '');

/** The wire's ASCII set as the site's typography: the straight apostrophe, the
 * straight quotes around the three answer tokens, and the hyphen the SMS uses
 * where prose takes an em dash. Presentation only — no word changes.
 *
 * And ONE punctuation repair, which is a cross-brief signal rather than a
 * licence: the go leg composes `${...timeOfDay}. Your link:` over a `timeOfDay`
 * that already ends in the period of "a.m.", so the wire really does send
 * "opens 6:30 a.m.. Your link:" — pinned, double stop and all, at
 * `apps/web/lib/registration/sequence/copy.test.ts:1292`. The landing sets one
 * period and the typo is filed against the voice brief; reproducing it would put
 * a product bug in 84px type, and silently rewriting the WORDS is what this
 * whole derivation exists to prevent. */
function asPageTypography(wire: string): string {
  return wire
    .replaceAll('.m..', '.m.')
    .replaceAll(' - ', ' — ')
    .replaceAll(/"([^"]*)"/g, '“$1”')
    .replaceAll("'", '’');
}

/** A renderer's template literal, with its interpolations filled from the row. */
function fill(frame: string): string {
  const filled = frame
    .replaceAll('${windowPhrase(shortlist)}', WINDOW_PHRASE)
    .replaceAll('${windowPhrase(input.shortlist)}', WINDOW_PHRASE)
    .replaceAll('${timeOfDay(input.anchor, input.timeZone)}', TIME_OF_DAY)
    .replaceAll('${whoPhrase(shortlist.fitNotes)}', CHILD)
    .replaceAll('${shortlist.sourceUrl}', LINK)
    .replaceAll('${phrase}', CHILD);
  if (filled.includes('${')) {
    throw new Error(`apps/web added an interpolation this fill does not know: ${filled}`);
  }
  return asPageTypography(filled);
}

const BATTLE_PLAN = fill(
  extract(SEQUENCE_COPY, /const municipal = `(Tomorrow: [^`]+)`;/, 'the battle-plan leg'),
);
const GO_LEG = fill(
  extract(
    SEQUENCE_COPY,
    /const municipal = `(\$\{windowPhrase\(shortlist\)\} opens[^`]*Your link: [^`]+)`;/,
    'the go leg',
  ),
);
const ANSWER_MENU = extract(SEQUENCE_COPY, /const ANSWER_MENU = '([^']+)';/, 'ANSWER_MENU');
const CHECK_IN_LEG = fill(
  `${extract(SEQUENCE_COPY, /return `(How did \$\{windowPhrase\(input\.shortlist\)\} go\?) \$\{ANSWER_MENU\}`;/, 'the check-in leg')} ${ANSWER_MENU}`,
);
const REGISTERED_REPLY = fill(
  `${extract(
    SEQUENCE_COPY,
    /return `(That's a spot\. Noted: )\$\{town\} \$\{shortlist\.windowRef\.cycleLabel\} registered\.`;/,
    'renderCheckInReply',
  )}${WINDOW_PHRASE} registered.`,
);
const LATER_CHECK_IN_ASK = fill(
  extract(
    CHECKIN_COPY,
    /function laterCheckInAsk\(phrase: string\): string \{\s*return `([^`]+)`;/,
    'laterCheckInAsk',
  ),
);
/** `WATCH_OFFER` is `${WATCH_OFFER_ASK}${frame}` with `${PRIVACY_URL}` inside the
 * frame — the one message in intake that carries a link, and the reason it is the
 * best frame on the page: a parent sees the privacy URL arrive unprompted, at the
 * turn where consent is asked. */
const WATCH_OFFER = (() => {
  const privacyUrl =
    extract(LEGAL_LINKS, /export const MARKETING_SITE_URL = '([^']+)';/, 'MARKETING_SITE_URL') +
    extract(
      LEGAL_LINKS,
      /export const PRIVACY_URL = `\$\{MARKETING_SITE_URL\}([^`]+)`;/,
      'PRIVACY_URL',
    );
  const ask = extract(INTAKE_COPY, /export const WATCH_OFFER_ASK = '([^']+)';/, 'WATCH_OFFER_ASK');
  const frame = extract(
    INTAKE_COPY,
    /export const WATCH_OFFER = `\$\{WATCH_OFFER_ASK\}([^`]+)`;/,
    'WATCH_OFFER',
  );
  return asPageTypography(
    ask + frame.replace('${PRIVACY_URL}', privacyUrl.replace(/^https:\/\/www\./, '')),
  );
})();
/** The ack, first and last clauses — see the elision note in T2. */
const NOTED_ACK = (() => {
  const wire = extract(
    CHECKIN_COPY,
    /export const CHECK_IN_NOTED_ACK[\s\S]*?en: "([^"]+)",/,
    'CHECK_IN_NOTED_ACK.en',
  ).split('. ');
  if (wire.length !== 3) throw new Error(`CHECK_IN_NOTED_ACK is no longer three clauses: ${wire}`);
  return asPageTypography(`${wire[0]}. ${wire[2]}`);
})();

describe('T1 · the loop is one conversation, in firing order', () => {
  const text = prose(render());

  it('runs the five beats in the order the product fires them', () => {
    const order = [
      'The first text',
      'A week later, the night before',
      'The next morning',
      'Four hours later',
      'That evening',
    ].map((marker) => text.indexOf(marker));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('draws it as one thread on one spine, not two conversations', () => {
    const html = render();
    // v4 ran a hero exchange and a transcript, and had to police them against
    // accidentally saying the same sentence twice (a word-set overlap check drawn
    // at 0.65). One conversation designs that whole class of defect out — so the
    // pin is that there is exactly ONE loop and exactly ONE spine on the page.
    expect([...html.matchAll(/class="v5-loop"/g)]).toHaveLength(1);
    expect([...html.matchAll(/class="v5-spine"/g)]).toHaveLength(1);
    expect(html).not.toContain('v4-hero-thread');
    expect(html).not.toContain('v4-thread-cap');
  });

  it('marks every beat and names the whole thread as an example', () => {
    const html = render();
    expect([...html.matchAll(/class="v5-stamp"/g)]).toHaveLength(5);
    expect(visibleText(html)).toContain('One family’s thread with Hale, start to finish');
  });
});

describe('T2 · every bubble quotes a string apps/web actually renders', () => {
  const text = prose(render());

  /**
   * The provenance table (brief R1), DERIVED rather than transcribed.
   *
   * Rev 1 of this suite pinned the bubbles as literals typed out of the brief,
   * which is a copy of apps/web living in apps/site: it cannot go red when the
   * wire changes, and — the defect that actually shipped — it cannot go red when
   * the SENTENCE is right and the VALUES in it are invented. The hero said
   * "Stouffville winter swim opens 7:00 a.m." against a dataset row that opens at
   * NOON, five hours later, with that landmine called out in a comment directly
   * above the row. So both halves are read out of apps/web now: the sentence
   * FRAMES out of the renderers, and the town, the clock and the link out of the
   * seeded window the ladder would fire from.
   *
   * ONE ELISION, marked here because an unmarked one is how a quotation rule
   * launders a product defect onto a marketing page: the evening ack ships as
   * "Noted - thanks. I'll keep it in mind for the weekend picks. Reply NO to
   * drop these." The middle clause is an overclaim in the product —
   * `family_check_in_notes` is read by nothing but the rights export and the
   * thirty-day purge (VIL-354) — so the page quotes the first and last clauses
   * and the ack's own wording is filed against the voice brief.
   */
  const QUOTED: [what: string, sentence: string][] = [
    ['WATCH_OFFER, whole, privacy link included', WATCH_OFFER],
    ['the battle-plan leg, the night before', BATTLE_PLAN],
    ['the go leg, as it opens', GO_LEG],
    ['the check-in leg and its ANSWER_MENU', CHECK_IN_LEG],
    ['renderCheckInReply, registered', REGISTERED_REPLY],
    ['laterCheckInAsk, the evening ask', LATER_CHECK_IN_ASK],
    ['CHECK_IN_NOTED_ACK, first and last clauses', NOTED_ACK],
  ];

  it.each(QUOTED)('renders the shipped sentence — %s', (_what, sentence) => {
    expect(text).toContain(sentence);
  });

  it('opens the ladder at the hour the dataset row really opens', () => {
    // THE ASSERTION THAT WOULD HAVE CAUGHT THE SHIPPED DEFECT. The two ladder
    // legs print `timeOfDay(anchor)`, so the page's clock is the row's clock or
    // it is fiction — and the dataset's own comment on the row this hero used to
    // be set in says why it matters: "NOON, which is the outlier in this dataset:
    // every other town here opens between 6 and 9 a.m., so a carried-over '7 a.m.'
    // would put a Stouffville parent five hours early."
    //
    // The two legs above already pin the clock BY VALUE (they are filled with
    // `timeOfDay(anchor)` and asserted whole). What this adds is the claim the
    // STAMP over them makes: the go leg is stamped "The next morning", which is
    // false of a noon window however faithfully the sentence is quoted.
    expect(LADDER_HOUR_24).toBeLessThan(12);
    expect(text).toContain('The next morning');
    expect(text).toContain(`opens ${TIME_OF_DAY}`);
  });

  it('hands over the municipality’s own page, and only on the ladder legs', () => {
    // ActivityPick deliberately carries no URL — the coach skill forbids the
    // model writing one, and a link it composes is a link it invented. The
    // ladder legs are different: their URL is a deterministic echo of a
    // dataset-verified string. So the page renders the distinction: no link in
    // the find beat, the town's own link in the two legs that carry one.
    const rendered = loop(render());
    expect([...rendered.matchAll(new RegExp(LINK.replaceAll('.', '\\.'), 'g'))]).toHaveLength(2);
    const findBeat = rendered.split('A week later')[0] ?? '';
    expect(findBeat, 'the find beat must render').toContain('Three near you');
    expect(findBeat).not.toContain(new URL(SOURCE_URL).hostname);
  });

  it('never re-says a product sentence the machine does not send', () => {
    // v4's draft of this beat said "Say YES and I'll watch for the date", which
    // is not a shipped string. The watch offer is, and it is the better frame:
    // a parent sees the privacy link arrive unprompted, at the consent turn.
    expect(text).not.toContain('Say YES and I’ll watch for the date');
  });

  it('carries no calendar date and no cycle year, so the loop cannot go stale', () => {
    const rendered = loop(render());
    expect(rendered, 'the loop must render for these absences to mean anything').toContain(
      'v4-bubble',
    );
    expect(rendered).not.toMatch(/\b20\d\d\b/);
    expect(rendered).not.toMatch(
      /\b(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\b/,
    );
  });

  it('spells the parent’s turns as a parent types them — no emoji in the thread', () => {
    // globals.css's own rule: "no emoji, ever". v4's transcript shipped one
    // ("got in 🙌") and nothing caught it. Scoped to the loop, which is where
    // the product's voice is quoted and where the stray one lived: the footer's
    // © is a legal mark and is Extended_Pictographic too.
    expect(loop(render())).not.toMatch(/\p{Extended_Pictographic}/u);
    // Positive control: the parent's turns ARE in there, so "no emoji" is a
    // property of real bubbles rather than of an empty match.
    expect(loop(render())).toContain('got in');
  });
});

describe('T3 · an empty loop is a build failure, not an empty hero', () => {
  it('throws on a beat with no rows rather than rendering a spine node with nothing under it', async () => {
    const { LoopThread } = await import('~/components/landing/v5/loop-thread.js');
    expect(() => LoopThread({ beats: [], cap: 'x', speaker: () => 'Hale:' })).toThrow();
    expect(() =>
      LoopThread({ beats: [{ elapsed: 'Later', rows: [] }], cap: 'x', speaker: () => 'Hale:' }),
    ).toThrow();
  });

  it('positive control: the five real beats render', () => {
    // Without this, the throw above would also pass against a component that
    // renders nothing at all — which is the exact failure it exists to prevent.
    expect([...render().matchAll(/class="v5-beat"/g)]).toHaveLength(5);
  });
});

describe('T4 · no claim the code cannot back', () => {
  const html = render();
  const text = prose(html);

  it('says nothing about travel — there is no trip concept anywhere in the product', () => {
    for (const word of [
      'New York',
      'travel',
      'trip',
      'vacation',
      'destination',
      'away from home',
    ]) {
      expect(text.toLowerCase(), `${word} must not appear`).not.toContain(word.toLowerCase());
    }
    // Positive control: the page DOES name where it works — twenty-one towns by
    // name — so "no travel" is a claim withheld, not a page that says nothing
    // about place.
    expect(text).toContain(`${MUNICIPALITY_COUNT} municipalities`);
    expect(text).toContain('Stouffville');
  });

  it('says nothing about what other parents thought — there is no review anywhere', () => {
    // No table, no verdict vocabulary, no k-threshold, and a web find has no
    // stable id to hang a review on. A landing page promising a corpus over a
    // pipeline with no handler is the exact failure these absences exist for.
    for (const phrase of ['other parents said', 'review', 'rating', 'out of 5', 'recommended by']) {
      expect(text.toLowerCase(), `${phrase} must not appear`).not.toContain(phrase.toLowerCase());
    }
    expect(text).not.toMatch(/\d+\s+families/);
    // Positive control: the page DOES describe the asking, which is the half
    // that ships.
    expect(text).toContain('Then I come back and ask.');
  });

  it('does not claim the Sunday brief — a SECOND flag gates that one', () => {
    // The ladder, the watched spots, the evening ask, the co-parent and the
    // caregivers are all one F14_ENABLED flip from sending, and the founder has
    // ruled that merged-and-tested is claimable. The Sunday text is not in that
    // set: it is blocked by LOOP_SEND_ENABLED as well ("compose-not-send until
    // the founder flips it"), so flipping F14 alone would not make it true.
    expect(text).not.toContain('A brief on Sunday');
    expect(text).not.toContain('Sunday');
    // Positive control: the cadence IS described — the legs that only need F14.
    expect(text).toContain('the night before');
  });

  it('never claims Hale registers the child itself — the parent taps the link', () => {
    for (const overclaim of [
      'I register',
      'I’ll register',
      'I sign you up',
      'books your spot',
      'guaranteed',
      'will fix',
    ]) {
      expect(text, `${overclaim} must not appear`).not.toContain(overclaim);
    }
    // Positive control: the page DOES describe the registration morning, so the
    // absences above are claims withheld rather than a missing section.
    expect(text).toContain('I run the morning with you');
  });

  it('keeps the four sourced facts and adds no fifth', () => {
    expect(text).toContain('open at 7:00 a.m.');
    expect(text).toContain('gone by 7:02');
    expect(text).toContain('$54');
    expect(text).toContain('twelve times');
    expect(text).toContain('head start of four days to two weeks');
    const withoutMe = text.split('Without me')[1]?.split('With me')[0] ?? '';
    expect(withoutMe, 'the without-me cell must render').toContain('gone by 7:02');
    for (const invented of ['%', 'out of 10', 'on average']) {
      expect(withoutMe, `${invented} must not appear`).not.toContain(invented);
    }
    expect(text).not.toContain('20%');
    expect(text).not.toContain('non-resident');
    expect(text).not.toContain('The 36 hours');
  });

  it('watches only what registration-windows-data.ts actually holds', () => {
    expect(text).toContain('Swim lessons');
    expect(text).toContain('Camps');
    expect(text).toContain('winter-break');
    expect(text).toContain('Waitlist clocks');
    for (const invented of ['March break', 'PA day', 'PA days', 'closures', 'school paperwork']) {
      expect(text).not.toContain(invented);
    }
    expect(text).not.toMatch(/summer/i);
  });

  it('claims no signup duration and no message count nobody measured', () => {
    for (const invented of [
      '2 minutes',
      'two minutes',
      '90 seconds',
      'in under a minute',
      'Three texts',
      'Three texts, then quiet.',
      'Take the family admin off your plate',
      'You say hi',
      'Silence is the normal state',
      'A brief on Monday',
      'Monday morning',
      'then quiet',
      'calendar invite',
      'They get just the schedule',
      'Three days later',
      'in three nights',
      'cure',
    ]) {
      expect(text, `${invented} must not appear`).not.toContain(invented);
    }
    expect(text).not.toMatch(/no forms/i);
    expect(text).toContain('You text names, ages, and a postal code');
  });

  it('invents no urgency around the founding rate', () => {
    expect(text).toContain('Founding families');
    for (const pressure of ['Only', 'spots left', 'Hurry', 'ends soon', 'Limited time']) {
      expect(text).not.toContain(pressure);
    }
  });

  it('has no web signup funnel, and offers sign-in only as the chrome’s quiet door', () => {
    for (const door of ['/sign-up', '/onboarding', '/preview']) expect(html).not.toContain(door);
    for (const label of ['Get started', 'Sign up', 'Join free', 'Create an account']) {
      expect(html).not.toContain(label);
    }
    const body = html
      .replace(/<header[\s\S]*?<\/header>/, '')
      .replace(/<footer[\s\S]*?<\/footer>/, '');
    expect(body).not.toContain('/sign-in');
    expect(body).not.toContain('>Sign in<');
  });

  it('has no metrics wired yet, so the band is omitted rather than zeroed', () => {
    expect(impactNumbers()).toBeNull();
    for (const label of ['families covered', 'registrations caught', 'weeks planned']) {
      expect(text).not.toContain(label);
    }
  });

  it('emits JSON-LD describing the page a visitor sees', () => {
    expect(html).toContain('application/ld+json');
    expect(html).toContain('A number your family texts');
    expect(html).not.toContain('passive household assistant');
  });
});

describe('T5 · the cadence is told truthfully', () => {
  const text = prose(render());

  it('names the evening ask and both of its printed exits', () => {
    expect(text).toContain('in the evening, one line');
    expect(text).toContain('Reply LESS and that becomes weekly, NO and it stops.');
  });

  it('names the ladder legs the registration sequence really fires', () => {
    expect(text).toContain('the night before');
    expect(text).toContain('Four hours after the window opens');
  });

  it('says where a day note goes and does not claim it is read', () => {
    // family_check_in_notes is read by nothing but the rights export and the
    // thirty-day purge, so "shapes what I suggest next week" would be an
    // overclaim. NOTE_RETENTION_DAYS = 30 is the one retention rule the code
    // actually keeps, and it is the only one the page states.
    expect(text).toContain('stays between us');
    expect(text).toContain('gone in thirty days');
    expect(text).not.toContain('shapes what I suggest');
  });
});

describe('T6 · the number is reachable and never readable', () => {
  const html = render();
  const text = prose(html);

  it('never prints the digits, in any grouping', () => {
    for (const rendering of [
      '+1 (647) 555-1234',
      '6475551234',
      '647-555-1234',
      '(647) 555-1234',
      '(647)',
    ]) {
      expect(text, `${rendering} must not be visible`).not.toContain(rendering);
    }
    // Positive control: the composer URI IS on the page, invisibly — encoded in
    // the closing QR — so "absent" means withheld rather than never rendered.
    expect(html).toContain('aria-label="QR code — scan to text Hale"');
  });

  it('opens no composer from the landing itself — the chooser owns the deep links', () => {
    expect([...html.matchAll(/<a\s[^>]*href="sms:[^>]*>/g)]).toHaveLength(0);
    expect([...html.matchAll(/data-cta="copy_number_click"/g)]).toHaveLength(0);
    expect(text).not.toContain('Copy number');
    expect(html).not.toContain('displaySmsNumber');
    expect(html).not.toContain('Message Hale');
  });
});

describe('T7 · the VIL-325 designer lock survives its relocation', () => {
  it('renders the locked words on the page, where the steps array used to be', () => {
    // The lock was pinned as `Landing.steps[0]`, an object that does not exist in
    // v5. The founder locked a SENTENCE, not an array index, so the pin follows
    // the words: the how-it-works prose carries them, and About.cta still does.
    const text = prose(render());
    expect(text).toContain('You text names, ages, and a postal code');
    expect(text).toContain('No app, no account.');
    expect(text).toContain('no menus');
  });
});

describe('the page’s own shape — two eyebrows, one card grid, no arrow', () => {
  const html = render();
  const text = prose(html);

  it('keeps one h1, in the display face, with the accent span intact', () => {
    expect([...html.matchAll(/<h1[\s>]/g)]).toHaveLength(1);
    const h1 = html.match(/<h1[\s\S]*?<\/h1>/)?.[0] ?? '';
    expect(h1).toContain('v4-display');
    expect(visibleText(h1)).toBe('I find it. You don’t miss it.');
    expect(h1).not.toContain('7:02');
    // The sub answers the pronoun the h1 opens on, in the next line.
    expect(text).toContain('the sign-up morning that fills by 7:02');
    // The accent span is STRUCTURE (WordsPullUp and the h1 both segment on it),
    // not a coloured word — .v4-accent is `color: inherit`.
    expect(h1).toContain('class="v4-accent"');
  });

  it('labels two sections and no more — the eyebrow stops being page furniture', () => {
    // v4 tracked an ALL-CAPS eyebrow above all seven sections plus a middle-dot
    // meta string in the hero. v5 keeps the two that mark a real change of
    // subject, and the pronunciation goes back to the footer, where it is brand
    // rather than chrome.
    expect([...html.matchAll(/class="v4-eyebrow"/g)]).toHaveLength(2);
    expect(html).not.toContain('v4-pronounce');
    expect(text).not.toContain('Hale · /HAH-leh/ · Hawaiian for home');
    // Positive control: the name is still said out loud, once, in the footer.
    const footer = html.match(/<footer[\s\S]*?<\/footer>/)?.[0] ?? '';
    expect(visibleText(footer)).toContain('Hale /HAH-leh/ — Hawaiian for home.');
  });

  it('ships exactly one card grid, and no numbered markers', () => {
    // The four watched items are genuinely a set of four peer things. Everything
    // else is thread, list or prose. The 01/02/03 numerals went with the
    // how-it-works grid: the sequence is the spine now, and numbering it twice
    // is the same conversation printed twice.
    const rails = [...html.matchAll(/<(?:div|ol)[^>]*class="v4-cardgrid[^"]*"[^>]*>/g)];
    expect(rails).toHaveLength(1);
    expect(rails[0]?.[0]).toContain('v4-cardgrid-4');
    expect(html).not.toContain('v4-card-n');
    expect(html).not.toContain('v4-when');
    for (const rail of rails) {
      expect(rail[0]).not.toContain('tabindex');
      expect(rail[0]).not.toContain('role=');
      expect(rail[0]).not.toContain('aria-label');
    }
  });

  it('takes the arrow off every CTA label — the label already says the verb', () => {
    expect([...html.matchAll(/Text Hale/g)]).toHaveLength(3);
    const chooserAnchors = [...html.matchAll(/<a\s[^>]*data-cta="cta_message_click"[^>]*>/g)].map(
      (m) => m[0],
    );
    for (const placement of ['header', 'hero', 'closing']) {
      expect(
        chooserAnchors.some((tag) => tag.includes(`data-cta-placement="${placement}"`)),
        `the ${placement} CTA must open the chooser, counted`,
      ).toBe(true);
    }
    for (const tag of chooserAnchors) expect(tag).toContain('href="/text"');
    // The arrow was a template tell and carried no information the label did not.
    expect(html).not.toContain('<span aria-hidden="true">→</span>');
    expect(html).not.toContain('→');
  });

  it('keeps the shore for the close and takes it out of the hero', () => {
    // The hero's argument is the loop, not the name; five beats and a spine over
    // a scrimmed photograph means re-measuring a contrast ladder tuned for three
    // bubbles, for a background arguing a different point. The shore survives
    // where the argument IS home — the closing band — and the hero's LCP element
    // becomes the h1.
    const imgs = html.match(/<img[^>]*>/g) ?? [];
    expect(imgs.filter((img) => img.includes('hale-shore-hero'))).toHaveLength(1);
    expect(imgs.filter((img) => img.includes('hale-shore-night'))).toHaveLength(0);
    for (const img of imgs) {
      expect(img, 'every image is decorative').toContain('alt=""');
      expect(img, 'every image is hidden from assistive tech').toContain('aria-hidden="true"');
      expect(img, `unexpected asset: ${img.slice(0, 90)}`).toMatch(/hale-logo|hale-shore-hero/);
    }
    for (const mascot of [
      'hale-turtle',
      'village-illustration',
      'diamondhead',
      'shore-ultrawide',
    ]) {
      expect(html, `${mascot} must not appear`).not.toContain(mascot);
    }
    // The one priority image left the critical path with it.
    expect([...html.matchAll(/fetchPriority="high"/gi)]).toHaveLength(0);
  });

  it('carries no question chips, and never dramatises the exchange as a real family', () => {
    expect(html).not.toContain('class="v4-chip');
    expect(html).not.toContain('class="v4-chips"');
    expect(html).not.toContain('hero_chip');
    expect(html).not.toContain('When does swim registration open near me?');
    for (const overclaim of ['from a real family', 'real customer', 'screenshot']) {
      expect(text).not.toContain(overclaim);
    }
  });

  it('shows the terms microcopy under the hero CTA, privacy link included', () => {
    expect(html).toContain('class="v4-hero-terms"');
    expect(text).toContain(
      'Free to start. You text first; standard message rates apply, reply STOP any time.',
    );
    expect(text).toContain('Your data stays in Canada — privacy policy');
    expect(html).toContain('href="/privacy"');
    const hero = html.match(/<section class="v5-hero[\s\S]*?<\/section>/)?.[0] ?? '';
    expect(hero, 'the hero must render').toContain('v5-loop');
    expect(visibleText(hero)).not.toContain('!');
  });

  it('orders the page the way the argument runs', () => {
    const order = [
      'I find it.',
      'The first text',
      'Three things, not thirty.',
      'The morning it opens, I’m already awake.',
      'Then I come back and ask.',
      'You text names, ages, and a postal code',
      'Run an EarlyON, a library branch or a centre?',
      'Founding families join free.',
    ].map((marker) => text.indexOf(marker));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('renders the finds in the finder’s own field shape, gap included', () => {
    // ActivityPick is name / ageFit / when / price / sourceName, and a null
    // `when` is the source not having published one. The honest rendering is to
    // say so rather than drop the pick or invent a time.
    expect([...html.matchAll(/class="v5-find"/g)]).toHaveLength(3);
    expect(text).toContain('Winter times not posted yet');
    expect(text).toContain(
      'If a page hasn’t posted its winter times yet, I tell you that instead of guessing one.',
    );
  });

  it('names every seeded municipality, as glass pills, one per town', () => {
    const cities = [
      'Toronto',
      'Mississauga',
      'Brampton',
      'Markham',
      'Vaughan',
      'Richmond Hill',
      'Oakville',
      'Burlington',
      'Halton Hills',
      'Caledon',
      'Ajax',
      'Pickering',
      'Whitby',
      'Oshawa',
      'Aurora',
      'Stouffville',
      'Newmarket',
      'King',
      'East Gwillimbury',
      'Georgina',
      'Uxbridge',
    ];
    expect(cities).toHaveLength(MUNICIPALITY_COUNT);
    for (const city of cities) expect(text).toContain(city);
    expect([...html.matchAll(/class="v4-pill v4-glass"/g)]).toHaveLength(MUNICIPALITY_COUNT);
  });

  it('renders the contrast as two stacked cells, never a phone snap rail', () => {
    expect([...html.matchAll(/class="v4-contrast[^"]*"/g)]).toHaveLength(1);
    expect(html).not.toMatch(/class="v4-contrast[^"]*v4-cardgrid/);
    expect(text).toContain('Without me');
    expect(text).toContain('With me');
  });

  it('says the built-dark things the founder cleared, and no more', () => {
    expect(text).toContain(
      'And when the class you wanted is already full, I keep watching it and text you the minute a place opens.',
    );
    expect(text).toContain('Your co-parent gets the same dates and nudges on their own number.');
    expect(text).toContain('just the schedule in scope');
    expect(text).toContain('I suggest');
    expect(text).toContain('I prepare');
    expect(text).toContain('with your ok, I handle it');
    expect(text.toLowerCase()).toContain('receipts');
    expect(text).toContain('nothing happens without your yes');
  });

  it('gives the second audience one line and a link, not a band', () => {
    expect(text).toContain('Run an EarlyON, a library branch or a centre?');
    expect(html).toContain('href="/for-centres"');
    // A card band for a second audience at the bottom is what makes a landing
    // page long. The full argument has its own page.
    const centres = text.split('Run an EarlyON')[1]?.slice(0, 400) ?? '';
    expect(centres).not.toContain('Without me');
  });
});

describe('the number is not provisioned', () => {
  const html = render({ number: '' });

  it('never renders a dead sms: link, and falls back to email', () => {
    expect(html).not.toContain('sms:');
    expect(html).not.toContain('Message Hale');
    expect(html).not.toContain('data-cta="cta_message_click"');
    expect(html).not.toContain('647');
    expect(html).toContain('href="mailto:aloha@villagehale.com"');
    expect(html).not.toContain('class="v4-chip');
  });

  it('still shows the loop and the sections — neither needs the number', () => {
    expect(html).toContain('class="v5-loop"');
    expect(visibleText(html)).toContain(`${MUNICIPALITY_COUNT} municipalities`);
  });
});
