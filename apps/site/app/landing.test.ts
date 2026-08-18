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

  it('keeps one h1, in the display serif, with the single amber italic accent', () => {
    expect([...html.matchAll(/<h1[\s>]/g)]).toHaveLength(1);
    const h1 = html.match(/<h1[\s\S]*?<\/h1>/)?.[0] ?? '';
    expect(h1).toContain('v4-display');
    expect(visibleText(h1)).toBe('Your family’s quiet chief of staff.');
    // The accent word is the v4 amber serif-italic — one segment, not the old glow.
    expect(h1).toContain('class="v4-italic"');
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
    expect(text).toContain('copy my number');
    expect(html).not.toContain('displaySmsNumber');
  });
});

describe('landing — the brand tile, the shore, and nothing else', () => {
  const html = render();

  /**
   * The honesty pin: the page carries the brand tile and two shore panels, and
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

  it('uses each shore panel once — the day hero and the night close — and no mascot art', () => {
    // Counted as <img> elements, not filename occurrences: next/image emits the
    // same asset name once per srcset candidate.
    const imgs = html.match(/<img[^>]*>/g) ?? [];
    expect(imgs.filter((img) => img.includes('hale-shore-hero'))).toHaveLength(1);
    expect(imgs.filter((img) => img.includes('hale-shore-night'))).toHaveLength(1);
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

  it('does not promise one town’s waitlist clock to every family', () => {
    // waitlistResponseHours varies across the seed (24/36/48/null). "The 36 hours"
    // promised every family the one value a single row carries.
    expect(text).not.toContain('The 36 hours');
  });

  it('tells the three texts and the suggest → prepare → handle ladder with receipts', () => {
    expect(text).toContain('You say hi');
    expect(text).toContain('I send your radar');
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

  it('offers the record by both doors a texting family actually has', () => {
    expect(text).not.toContain('waits in your account');
    expect(text).toContain('ask me in the thread');
    expect(text).toContain('sign in with your phone number');
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
      'family’s quiet',
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

  it('names the seven plannable topics and no others', () => {
    for (const topic of [
      'Sleep',
      'starting solids',
      'potty training',
      'picky eating',
      'tantrums',
      'screen time',
      'routines',
    ]) {
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
    expect(html).not.toContain('Text Hale');
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
