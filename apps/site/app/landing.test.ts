import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { APP_URL } from '~/lib/app-url.js';
import { impactNumbers } from '~/lib/landing/impact.js';
import LandingPage from './[locale]/page.js';

/**
 * villagehale.com — the v4 liquid-glass shore, the one landing.
 *
 * The pivot's argument is that the only way in is texting Hale, so the strongest
 * assertions here are the negative ones: no signup funnel, no capability claimed
 * that isn't live, no placeholder metrics, and no digits. Those invariants
 * carried over from the landing this replaced unchanged; only the assertions that
 * described the old conversational hero's markup (the typed bubble, the v3 chips)
 * were re-pointed at what v4 actually renders.
 */

const LIVE_NUMBER = '+16475551234';

// The landing is now an async Server Component (it awaits the `[locale]` param),
// so both states are rendered once at module load — English, the default locale —
// and `render()` stays synchronous for the describe/it bodies that call it.
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

/** The homepage with the number provisioned — the live state (default). */
function render({ number = LIVE_NUMBER }: { number?: string } = {}): string {
  return number === '' ? EMPTY_HTML : LIVE_HTML;
}

function visibleText(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('landing — the v4 hero', () => {
  const html = render();

  it('opens on the shore hero, scrimmed behind glass', () => {
    expect(html).toContain('class="v4-hero"');
    expect(html).toContain('class="v4-hero-art"');
    expect(html).toContain('class="v4-hero-scrim"');
  });

  it('keeps one h1, in the display serif, with the single amber accent', () => {
    expect([...html.matchAll(/<h1[\s>]/g)]).toHaveLength(1);
    const h1 = html.match(/<h1[\s\S]*?<\/h1>/)?.[0] ?? '';
    expect(h1).toContain('v4-display');
    // The founder-approved poster stack. The brand line may lead ONLY because the
    // sub resolves it in one breath — the v1 hero died when this same line stood
    // over a paragraph that never got to the point, and the 7:02-first hero died
    // as a hook with no introduction. H1 names the brand; the next line says what
    // it is in a parent's words.
    expect(visibleText(h1)).toBe('The family assistant you text.');
    expect(h1).not.toContain('7:02');
    // Outcome-first, verb-led: the sub leads with what the reader gets rid of,
    // not with a pronoun that makes them wait for the subject.
    expect(html).toContain('Take the family admin off your plate');
    // The accent word is amber at the heading's own weight — colour, not slant.
    expect(h1).toContain('class="v4-accent"');
  });

  it('leads with the name, said out loud, as the eyebrow', () => {
    expect(html).toContain('Hale · /HAH-leh/ · Hawaiian for home');
  });

  it('carries a conversion surface in the hero nav and the hero body', () => {
    // Two Text Hale CTAs above the fold — the nav pill and the hero — both the
    // composer deep link, so the first text costs a tap.
    expect([...html.matchAll(/>Text Hale</g)].length).toBeGreaterThanOrEqual(2);
    expect(html).toContain('href="sms:+16475551234?&amp;body=Hi"');
  });

  it('shows what texting Hale is like as a static thread, not a typed dramatisation', () => {
    const text = visibleText(html);
    expect(text).toContain('Texting Hale looks like this');
    expect(text).toContain('Your thread with Hale');
    // A real exchange, rendered as message bubbles — never claimed to be a real family.
    expect(html).toContain('class="v4-bubble v4-bubble-out"');
    expect(html).toContain('class="v4-bubble v4-bubble-in"');
    for (const overclaim of ['from a real family', 'real customer', 'screenshot']) {
      expect(text).not.toContain(overclaim);
    }
  });

  it('renders the four reply chips as composer deep links carrying the parent’s words', () => {
    expect([...html.matchAll(/class="v4-chip v4-glass"/g)]).toHaveLength(4);
    expect(html).toContain('When does swim registration open near me?');
    // Each chip pre-writes a question into the composer, not the bare greeting.
    expect(html).toContain('sms:+16475551234?&amp;body=When%20does%20swim');
  });

  it('declares the hierarchy in the chips — three logistics questions, then one coaching one', () => {
    // Registration is the lead job; coaching is why the thread stays open between
    // windows. Four chips of equal billing made the page read as three products.
    const order = [
      'When does swim registration open near me?',
      'When do winter-break camps open?',
      'What’s on this weekend for a toddler?',
      'My 2-year-old won’t nap — what do I try?',
    ].map((chip) => html.indexOf(chip));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});

describe('landing — the number is reachable and never readable', () => {
  const html = render();
  const text = visibleText(html);

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
    // Positive control: the number IS on the page, invisibly, so "absent" means
    // withheld rather than never rendered at all.
    expect(html).toContain('href="sms:+16475551234?&amp;body=Hi"');
  });

  it('offers the clipboard as the laptop path instead of the digits', () => {
    // The copy chip puts the number on the clipboard without printing it — the
    // Windows/laptop path where `sms:` is a silent no-op.
    expect(text).toContain('Copy number');
    expect(html).not.toContain('displaySmsNumber');
  });
});

describe('landing — the brand tile, the shore, and nothing else', () => {
  const html = render();

  /**
   * The honesty pin: the page carries the brand tile and the day shore, and
   * the rule underneath is that no image carries an argument — every one is
   * decorative, from the known asset set, and none stands in for a real customer.
   */
  it('allows only decorative images, only from the brand set', () => {
    const imgs = html.match(/<img[^>]*>/g) ?? [];
    // Positive control: there ARE images, so the per-image assertions below are
    // checking something rather than iterating an empty list.
    expect(imgs.length).toBeGreaterThanOrEqual(3);
    for (const img of imgs) {
      expect(img, 'every image is decorative').toContain('alt=""');
      expect(img, 'every image is hidden from assistive tech').toContain('aria-hidden="true"');
      expect(img, `unexpected asset: ${img.slice(0, 90)}`).toMatch(
        /hale-logo|hale-shore-hero|hale-shore-night/,
      );
    }
  });

  it('holds the same line over the art that is DRAWN rather than fetched', () => {
    // The scan above reads <img>, and since 2026-08-20 the brand's loudest mark on
    // this page is not one: the wordmark is an inline <svg>. Three of them ship in
    // the header, the closing card and the footer, and an <img>-only honesty pin
    // would have said nothing about any of them. Every drawing on this page is
    // decorative — the two lucide icons in the theme switch and the language
    // selector, and the three wordmarks, all of which are named by the control or
    // the sr-only text beside them rather than by the art.
    const svgs = html.match(/<svg[^>]*>/g) ?? [];
    expect(svgs.length).toBeGreaterThanOrEqual(5);
    for (const svg of svgs) {
      expect(svg, `a drawing that is not decorative: ${svg.slice(0, 90)}`).toContain(
        'aria-hidden="true"',
      );
    }
    // Positive control: the wordmark's name still reaches the tree beside the art.
    expect([...html.matchAll(/<span class="sr-only" translate="no">Hale<\/span>/g)]).toHaveLength(3);
  });

  it('uses the day shore for both the hero and the close, no night panel, and no mascot art', () => {
    // Counted as <img> elements, not filename occurrences. The day shore now backs
    // BOTH the hero and the closing band; the night panel was retired (readability).
    const imgs = html.match(/<img[^>]*>/g) ?? [];
    expect(imgs.filter((img) => img.includes('hale-shore-hero'))).toHaveLength(2);
    expect(imgs.filter((img) => img.includes('hale-shore-night'))).toHaveLength(0);
    for (const mascot of ['hale-turtle', 'village-illustration', 'diamondhead', 'shore-ultrawide']) {
      expect(html, `${mascot} must not appear`).not.toContain(mascot);
    }
  });

  it('says the name out loud in the shared footer', () => {
    const footer = html.match(/<footer[\s\S]*?<\/footer>/)?.[0] ?? '';
    expect(visibleText(footer)).toContain('Hale /HAH-leh/ — Hawaiian for home.');
    expect(html).toContain('/HAH-leh/');
    expect(html).toContain('Hawaiian for home');
  });

  it('ends every page in the one shared footer, with the theme switch', () => {
    // The v4 theme switch lives in the footer, not the bar.
    const footer = html.match(/<footer[\s\S]*?<\/footer>/)?.[0] ?? '';
    expect(footer).toContain('class="v4-switch"');
  });
});

describe('landing — no signup funnel; the only way in is texting Hale', () => {
  const html = render();
  const text = visibleText(html);

  it('has no web signup funnel anywhere', () => {
    expect(html).not.toContain('/sign-up');
    expect(html).not.toContain('/onboarding');
    expect(html).not.toContain('/preview');
    for (const label of ['Get started', 'Sign up', 'Join free', 'Create an account']) {
      expect(html).not.toContain(label);
    }
  });

  it('keeps Sign in a single quiet link in the footer, pointed at the app', () => {
    // v4 dropped the header Sign in; the footer's Resources column carries it.
    expect([...html.matchAll(/\/sign-in"/g)]).toHaveLength(1);
    for (const match of html.matchAll(/href="([^"]*\/sign-in)"/g)) {
      expect(match[1]).toBe(`${APP_URL}/sign-in`);
    }
  });

  it('invents no urgency around the founding rate', () => {
    expect(text).toContain('Founding families');
    for (const pressure of ['Only', 'spots left', 'Hurry', 'ends soon', 'Limited time']) {
      expect(text).not.toContain(pressure);
    }
  });
});

describe('landing — sections, in the Surfaces Plan order', () => {
  const html = render();
  const text = visibleText(html);

  it('names all fifteen seeded municipalities it watches', () => {
    for (const city of [
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
    ]) {
      expect(text).toContain(city);
    }
    expect(text).toContain('15 municipalities');
  });

  it('renders the fifteen cities as glass pills, one per municipality', () => {
    // The city list is a hand-kept copy of the `Municipality` union in
    // packages/db (apps/site cannot import @hale/db); the count catches a drift.
    expect([...html.matchAll(/class="v4-pill v4-glass"/g)]).toHaveLength(15);
  });

  it('watches only what registration-windows-data.ts actually holds', () => {
    expect(text).toContain('Swim lessons');
    expect(text).toContain('Camps');
    expect(text).toContain('winter-break');
    expect(text).toContain('Waitlist clocks');
    for (const invented of ['March break', 'PA day', 'PA days', 'closures']) {
      expect(text).not.toContain(invented);
    }
    expect(text).not.toMatch(/summer/i);
    expect(text).not.toContain('school paperwork');
  });

  it('proves the pain with the sourced facts instead of asserting usefulness', () => {
    // The four "wait, really?" facts, each sourced in the positioning doc §9:
    // the 7:02 fill (self-explained in the hero sub: opens at 7:00, gone by 7:02),
    // the ~12× private-vs-city swing, the resident head start, and the waitlist
    // clock. Anything not on that list is an invented number.
    expect(text).toContain('open at 7:00 a.m.');
    expect(text).toContain('gone by 7:02');
    expect(text).toContain('$54');
    expect(text).toContain('twelve times');
    expect(text).toContain('head start of four days to two weeks');
    // The unsourced claim the doc explicitly parks until a per-town check exists.
    expect(text).not.toContain('20%');
    expect(text).not.toContain('non-resident');
  });

  it('does not promise one town’s waitlist clock to every family', () => {
    // waitlistResponseHours varies across the seed (24/36/48/null). "The 36 hours"
    // promised every family the one value a single row carries.
    expect(text).not.toContain('The 36 hours');
  });

  it('tells the three texts and the suggest → prepare → handle ladder with receipts', () => {
    expect(text).toContain('You say hi');
    // Step 2 is where Hale proves itself, so it is written in a parent's words —
    // "radar" is internal vocabulary and cannot be the first description.
    expect(text).toContain('I text back your week');
    expect(text).toContain('I keep watch');
    expect(text).toContain('I suggest');
    expect(text).toContain('I prepare');
    expect(text).toContain('with your ok, I handle it');
    expect(text.toLowerCase()).toContain('receipts');
  });

  it('describes the real cadence — a Monday brief and the open-day ladder, not pure silence', () => {
    expect(text).toContain('A brief on Monday');
    expect(text).toContain('the night before');
    expect(text).not.toContain('Silence is the normal state');
  });

  it('names the calendar invite as the receipt an approval actually produces', () => {
    expect(text.toLowerCase()).toContain('calendar');
    expect(text.toLowerCase()).toContain('invite');
  });

  it('covers the caregivers and the co-parent, and keeps the roles honest', () => {
    expect(text).toContain('just the schedule');
    expect(text).toContain('co-parent');
    // "Village" is reserved for the family-to-family intros product; this section
    // is scoped caregiver access.
    expect(text).toContain('Your helpers');
  });

  it('makes the privacy claim Canadian and links the policy page', () => {
    expect(text).toContain('stays in Canada');
    expect(html).toContain('href="/privacy"');
  });

  it('sends questions to the single canonical FAQ instead of duplicating it', () => {
    expect(html).toContain('href="/faq"');
  });

  it('orders the sections the way the Surfaces Plan does', () => {
    const order = [
      'The family assistant',
      'Texting Hale looks like this',
      'How Hale works',
      'What I watch',
      'When you ask me something',
      'Your helpers',
      'the Canadian way',
      'Founding families',
    ].map((marker) => text.indexOf(marker));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});

describe('landing — parenting coaching: the answer, the plan, the check-in', () => {
  const text = visibleText(render());

  it('tells the three coaching beats the SMS coach and coach-plan skill actually ship', () => {
    expect(text).toContain('You ask');
    expect(text).toContain('I offer the whole plan');
    // The check-in day is model-chosen and PROMISED in the plan's own text, so the
    // landing claims the promise, not a fixed count.
    expect(text).toContain('I name the day in the plan');
    expect(text).not.toContain('Three days later');
  });

  it('keeps the topic claim to the header trio — the full list lives in the FAQ', () => {
    // The seven-topic card went in the sparseness pass; the FAQ's coaching answer
    // still names all seven, and the landing claims only what its header shows.
    for (const topic of ['Sleep', 'solids', 'potty']) {
      expect(text).toContain(topic);
    }
  });

  it('names the methods the shipped plan actually attributes', () => {
    for (const method of ['Ferber', 'three-day', 'Health Canada']) {
      expect(text).toContain(method);
    }
  });

  it('carries the medical boundary the skill enforces, with no outcome promise', () => {
    expect(text).toContain('doctor');
    for (const promise of ['guaranteed', 'will fix', 'in three nights', 'cure']) {
      expect(text).not.toContain(promise);
    }
  });
});

describe('landing — the phone snap rails', () => {
  it('ships them with no focus attributes baked into the server markup', () => {
    // The four card sets that become horizontal snap rails under 640px (the
    // coaching boundary card stands alone since the sparseness pass). Matching
    // the opening tags is the positive control: the absences below are attributes
    // withheld from rails that are demonstrably here, not four missing sections.
    const rails = [...render().matchAll(/<(?:div|ol)[^>]*class="v4-cardgrid[^"]*"[^>]*>/g)].map(
      (match) => match[0],
    );
    expect(rails).toHaveLength(4);
    // tabindex/role/aria-label are attached on mount and only while a rail really
    // overflows. Static ones would be five dead tab stops on the desktop
    // composition, where the grid wraps and there is nothing to scroll.
    for (const rail of rails) {
      expect(rail).not.toContain('tabindex');
      expect(rail).not.toContain('role=');
      expect(rail).not.toContain('aria-label');
    }
  });
});

describe('landing — structured data', () => {
  it('emits its own JSON-LD graph describing the page a visitor actually sees', () => {
    const html = render();
    expect(html).toContain('application/ld+json');
    expect(html).toContain('A number your family texts');
    expect(html).not.toContain('passive household assistant');
  });
});

describe('landing — impact numbers, the honesty rule', () => {
  it('has no metrics wired yet, so the band is omitted rather than zeroed', () => {
    expect(impactNumbers()).toBeNull();
    const text = visibleText(render());
    for (const label of ['families covered', 'registrations caught', 'weeks planned']) {
      expect(text).not.toContain(label);
    }
  });
});

describe('landing — number not provisioned', () => {
  const html = render({ number: '' });

  it('never renders a dead sms: link, and falls back to email', () => {
    expect(html).not.toContain('sms:');
    // No CTA labelled for a dead channel. The h1's "Text Hale." stays — it names
    // what the product is — but every button degrades to the email door.
    expect(html).not.toContain('>Text Hale<');
    expect(html).not.toContain('647');
    expect(html).toContain('href="mailto:aloha@villagehale.com"');
    // Positive control: with no number the composer chips are gone too, so the
    // absence above is the whole SMS surface withheld, not one link missing.
    expect(html).not.toContain('class="v4-chip v4-glass"');
  });

  it('still shows the thread demo and the sections — neither needs the number', () => {
    expect(html).toContain('Your thread with Hale');
    expect(visibleText(html)).toContain('15 municipalities');
  });
});

describe('landing — the thread is one continuous registration loop', () => {
  const html = render();
  const text = visibleText(html);
  const thread = html.match(/<div class="v4-thread[\s\S]*?<\/section>/)?.[0] ?? '';

  /**
   * The demo runs the four legs `apps/web/lib/registration/sequence/schedule.ts`
   * actually schedules — HEADS_UP_LEAD_DAYS = 7, the battle plan at
   * BATTLE_PLAN_MINUTE_LOCAL the evening before, GO_LEAD_MINUTES = 15, and the
   * check-in CHECK_IN_LEAD_HOURS = 4 after the open. apps/site cannot import
   * apps/web, so the intervals are a hand-kept copy and these markers are what
   * catch a drift.
   */
  it('runs the four scheduled legs, in the order the sequence fires them', () => {
    const order = [
      'A week before',
      'The evening before',
      'Fifteen minutes before',
      'Four hours later',
    ].map((marker) => text.indexOf(marker));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('renders each leg as a timestamp between bubbles, never as another bubble', () => {
    expect([...html.matchAll(/class="v4-thread-time"/g)]).toHaveLength(4);
    // Positive control: the bubbles are still bubbles, so "four timestamps" is a
    // separate row type rather than four mislabelled messages.
    expect([...html.matchAll(/class="v4-bubble v4-bubble-in"/g)].length).toBeGreaterThanOrEqual(5);
    expect([...html.matchAll(/class="v4-bubble v4-bubble-out"/g)]).toHaveLength(2);
  });

  it('tells the whole story: the warning, the parent’s yes, the link, the receipt', () => {
    expect(text).toContain('registration opens Tuesday at 7:00 a.m.');
    expect(text).toContain('Reply YES and I’ll run the morning with you');
    expect(text).toContain('Sign in tonight');
    expect(text).toContain('Your link:');
    expect(text).toContain('That’s a spot.');
  });

  it('quotes the sequence renderer’s own sentences instead of marketing copy', () => {
    // Every one of these is a literal from apps/web/lib/registration/sequence/copy.ts
    // (headsUp / battlePlan / go / checkIn / renderCheckInReply), so the landing
    // cannot promise a message the product does not send.
    expect(text).toContain('Your postal code gets the residents-first date.');
    expect(text).toContain('Tomorrow:');
    expect(text).toContain('“got in”');
    expect(text).toContain('“missed it”');
    // The real registration page for the row this is drawn from — Hale never
    // stands between a parent and the municipal form.
    expect(text).toContain('haltonhills.ca/Play/Recreation/Programs');
  });

  it('carries no calendar date or cycle year, so the demo cannot go stale', () => {
    // The live heads-up prints "Sep 1, 7:00 a.m." and the cycle label "Fall 2026";
    // the demo prints the published WEEKDAY and a bare season from the same
    // verified row instead, both of which stay true after that window closes.
    expect(thread, 'the thread must render for these absences to mean anything').toContain(
      'v4-thread-time',
    );
    expect(thread).not.toMatch(/\b20\d\d\b/);
    expect(thread).not.toMatch(
      /\b(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\b/,
    );
  });

  it('never claims Hale registers the child itself — the parent taps the link', () => {
    for (const overclaim of [
      'I register',
      'I’ll register',
      'I sign you up',
      'books your spot',
      'guaranteed',
    ]) {
      expect(text, `${overclaim} must not appear`).not.toContain(overclaim);
    }
    // Positive control: the page DOES describe the registration morning, so the
    // absences above are claims withheld rather than a missing section.
    expect(text).toContain('I run the morning with you');
  });
});

describe('landing — without me / with me, in the section that already holds the facts', () => {
  const html = render();
  const text = visibleText(html);

  it('renders the contrast as two stacked cells, not a phone snap rail', () => {
    // A before/after that rails on a phone shows only the "before" until you swipe,
    // which is the one layout that destroys a contrast. .v4-contrast stacks.
    expect([...html.matchAll(/class="v4-contrast[^"]*"/g)]).toHaveLength(1);
    expect(html).not.toMatch(/class="v4-contrast[^"]*v4-cardgrid/);
    expect(text).toContain('Without me');
    expect(text).toContain('With me');
  });

  it('keeps all four sourced facts on the without-me side, and adds no fifth', () => {
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
  });

  it('does not restate the ladder a third time on the with-me side', () => {
    // The thread SHOWS the ladder and step three SUMMARISES it. A third telling
    // here is the bloat the sparse landing exists to prevent.
    const withMe = text.split('With me')[1]?.slice(0, 240) ?? '';
    expect(withMe, 'the with-me cell must render').toContain('reply YES once');
    expect(withMe).not.toContain('evening before');
    expect(withMe).not.toContain('week out');
  });
});

describe('landing — the first-week contract, folded into How Hale works', () => {
  const html = render();
  const text = visibleText(html);

  it('marks when each of the three steps actually happens', () => {
    expect([...html.matchAll(/class="v4-when"/g)]).toHaveLength(3);
    expect(text).toContain('Right now');
    expect(text).toContain('In the same thread');
    expect(text).toContain('Then every week');
  });

  it('never promises a Sunday plan — the weekly brief defaults to Monday morning', () => {
    // packages/db: users.weekStartDay defaults to 1 and loop_prefs
    // .weekly_plan_send_time to 08:00, and apps/web/lib/loop/send.ts sends on
    // weeklyPlanWeekday(weekStartDay) — Monday 08:00 local, not Sunday.
    expect(text).not.toContain('Sunday');
    expect(text).not.toContain('Sunday plan');
    // Positive control: the page DOES name the brief's day, so the absence above
    // is the wrong day withheld rather than the cadence going unmentioned.
    expect(text).toContain('A brief on Monday');
  });

  it('claims no signup duration nobody measured', () => {
    for (const invented of ['2 minutes', 'two minutes', '90 seconds', 'in under a minute']) {
      expect(text, `${invented} must not appear`).not.toContain(invented);
    }
    // What IS countable: hi, the details, the yes.
    expect(text).toContain('Three texts');
  });
});
