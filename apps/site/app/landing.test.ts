import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { APP_URL } from '~/lib/app-url.js';
import { impactNumbers } from '~/lib/landing/impact.js';
import LandingPage from './page.js';

/**
 * villagehale.com — the one landing.
 *
 * Every claim, boundary and omission that the two suites guarding the pages
 * before this one pinned is carried here unchanged. Only the assertions that
 * described markup no longer on the page were dropped: the previous hero's copy
 * and its three-bubble transcript figure.
 *
 * The pivot's whole argument is that the only way in is texting Hale, so the
 * strongest assertions here are the negative ones: no signup funnel, no
 * capability claimed that isn't live, no placeholder metrics, and no digits.
 */

const LIVE_NUMBER = '+16475551234';

/** The homepage with the number provisioned — the live state. */
function render({ number = LIVE_NUMBER }: { number?: string } = {}): string {
  vi.stubEnv('NEXT_PUBLIC_HALE_SMS_NUMBER', number);
  return renderToStaticMarkup(createElement(LandingPage));
}

function visibleText(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Curly punctuation is the site's display layer; the worker sends plain ASCII. */
function plain(text: string): string {
  return text.replace(/[’‘]/g, "'").replace(/[—–]/g, '-').replace(/\s+/g, ' ').trim();
}

/** globals.css, for the assertions that read the theme rather than the markup. */
function globalsCss(): string {
  return readFileSync(fileURLToPath(new URL('./globals.css', import.meta.url)), 'utf8');
}

function hex(value: string): [number, number, number] {
  const s = value.replace('#', '');
  return [0, 2, 4].map((i) => Number.parseInt(s.slice(i, i + 2), 16)) as [number, number, number];
}

/** Relative luminance, for the contrast assertions on the dark ladder. */
function luminance(value: string): number {
  const channel = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = hex(value);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: string, b: string): number {
  const first = luminance(a);
  const second = luminance(b);
  const hi = Math.max(first, second);
  const lo = Math.min(first, second);
  return (hi + 0.05) / (lo + 0.05);
}

/** A declaration's value inside the `prefers-color-scheme: dark` `.v3-theme` block. */
function darkToken(name: string): string {
  const block = /@media \(prefers-color-scheme: dark\) \{\s*\.v3-theme \{([\s\S]*?)\n {2}\}/.exec(
    globalsCss(),
  )?.[1];
  if (!block) throw new Error('globals.css no longer has a dark .v3-theme block');
  const found = new RegExp(`${name}:\\s*([^;]+);`).exec(block)?.[1];
  if (!found) throw new Error(`${name} is not declared in the dark block`);
  return found.trim();
}

/**
 * `greeting(null)` as the worker would send it, read out of the source rather
 * than restated here — a copy of the copy would drift in step with the page and
 * pin nothing.
 *
 * Structural, not textual: the venue-less greeting is the function's LAST return
 * (the fall-through past `if (venue)`), and the ask it interpolates is the shared
 * COLD_START_ASK constant. Matching on the words instead would have re-encoded
 * the very string under test — and did, on the first pass: an anchor on "Hi, I'm
 * Hale - an AI" pulled the QR-venue branch and compared the page against a
 * message it never shows.
 */
function workerGreeting(): string {
  const source = readFileSync(
    fileURLToPath(new URL('../../web/lib/channel/intake/copy.ts', import.meta.url)),
    'utf8',
  );
  const fn = /export function greeting\([^)]*\): string \{([\s\S]*?)\n\}/.exec(source);
  const returns = [...(fn?.[1] ?? '').matchAll(/return `([^`]*)`;/g)].map((m) => m[1]);
  const ask = /export const COLD_START_ASK =\s*"([^"]+)"/.exec(source);
  const body = returns.at(-1);
  if (!body || !ask?.[1]) throw new Error('intake/copy.ts no longer exposes greeting(null)');
  // Two branches today — venue, then the cold start. If that ever collapses to
  // one, this is reading the wrong message and must be revisited.
  expect(returns).toHaveLength(2);
  return body.replace('${COLD_START_ASK}', ask[1]);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('landing — the dark theme is Hale navy, and it stays on the landing', () => {
  it('grounds dark mode in Prussian navy rather than a neutral dark', () => {
    // The founder's rule: dark must read navy, not black. Derived from the brand
    // navy #17294A — the ground is the deepest step of that hue and the card IS
    // the brand navy. Pinned as the hue relationship rather than one hex so a
    // retune stays possible and a slide back to the charcoal ladder this replaced
    // (#14120E, where blue was the SMALLEST channel) cannot.
    const ground = darkToken('--color-linen');
    const [r, g, b] = hex(ground);
    expect(b, `${ground} must be blue-dominant`).toBeGreaterThan(g);
    expect(g, `${ground} must be blue-dominant`).toBeGreaterThan(r);
    expect(b - r, `${ground} must be saturated navy, not a neutral dark`).toBeGreaterThanOrEqual(
      28,
    );
    expect(luminance(ground), `${ground} must still be a dark ground`).toBeLessThan(0.02);
    // The card is the brand navy itself, which is what makes the ladder Hale's.
    expect(darkToken('--color-oat')).toBe('#17294a');
    expect(darkToken('--color-page')).toBe(ground);
  });

  it('keeps every dark ink step above AA on the lightest surface it lands on', () => {
    // The card (--color-oat) is the lightest ground any body or meta text sits on,
    // so it is the binding constraint for the whole ladder.
    const card = darkToken('--color-oat');
    expect(contrast(darkToken('--color-spruce'), card)).toBeGreaterThanOrEqual(7);
    expect(contrast(darkToken('--color-slate-green'), card)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(darkToken('--color-faded-sage'), card)).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps amber a mark, never an ink that cannot carry the job', () => {
    // #B26B1F is 4.12:1 on the navy ground and 3.45:1 on the card — below AA in
    // both places — so dark swaps in the lighter amber for the caret, the accent
    // halo and the focus ring. The light theme keeps #B26B1F; this is the pin
    // that stops it being carried across unchanged.
    const amber = darkToken('--color-amber');
    expect(amber).not.toBe('#b26b1f');
    expect(contrast(amber, darkToken('--color-oat'))).toBeGreaterThanOrEqual(4.5);
    expect(darkToken('--color-apricot-deep')).toBe(amber);
    // The #FEF0C7 wash cannot survive on navy under cream ink, so it becomes a
    // low-alpha amber that composites over whichever navy is behind it.
    expect(darkToken('--color-apricot-tint')).toMatch(/^rgb\(.*\/\s*0?\.\d+\)$/);
  });

  it('closes the shore band on the page ground, so the night is continuous', () => {
    // The art's own edges are #051C3B–#081E3D. In dark the band takes the page
    // ground, which dissolves the 28px card corners; in light it stays its own
    // statement night against the warm page.
    expect(darkToken('--v3-shore-ground')).toBe(darkToken('--color-linen'));
    const css = globalsCss();
    expect(css).toContain('background: var(--v3-shore-ground);');
    // Positive control: the light value is still a fixed night, not inherited.
    expect(/\.v3-theme \{[\s\S]*?--v3-shore-ground: #0c1424;/.test(css)).toBe(true);
  });

  it('confines dark mode to the landing — no theme override escapes to :root', async () => {
    // Dark mode arrives as custom properties re-pointed on a wrapper class. The
    // invariant that keeps every subpage light-only is that no
    // prefers-color-scheme: dark rule in globals.css targets anything outside the
    // theme class. One `:root` in that media query would flip the whole marketing
    // site in the same deploy.
    const postcss = (await import('postcss')).default;

    const selectors: string[] = [];
    postcss.parse(globalsCss()).walkAtRules('media', (rule) => {
      if (!rule.params.includes('prefers-color-scheme')) return;
      if (!rule.params.includes('dark')) return;
      rule.walkRules((inner) => {
        selectors.push(inner.selector.replace(/\s+/g, ' ').trim());
      });
    });

    // Positive control: the dark block exists at all, so the assertion below is
    // scanning something rather than passing on an empty list.
    expect(selectors.length).toBeGreaterThan(0);
    for (const selector of selectors) {
      expect(selector, `${selector} must be scoped to the landing theme`).toContain('-theme');
    }
  });

  it('carries the theme class on the page root, where the tokens have to inherit from', () => {
    expect(render().match(/<main[^>]*>/)?.[0] ?? '').toContain('v3-theme');
  });
});

describe('landing — the hero is the real conversation', () => {
  const html = render();

  it('types the greeting the worker actually sends, word for word', () => {
    // The drift gate. The bubble's sizer span holds the whole message in the DOM
    // (it is what a crawler and a reader with JavaScript off get), so it is the
    // copy this compares — and it must equal intake/copy.ts once the site's
    // curly quotes and em dashes are normalised back to the wire's ASCII.
    const sizer = /<span class="v3-bubble-sizer" aria-hidden="true">([\s\S]*?)<\/span>/.exec(html);
    expect(sizer?.[1]).toBeTruthy();
    expect(plain(visibleText(sizer?.[1] ?? ''))).toBe(plain(workerGreeting()));
  });

  it('labels the bubble as Hale’s real opening message, not a dramatisation', () => {
    const text = visibleText(html);
    expect(text).toContain('Hale texts like this — this is its real opening message');
    for (const overclaim of ['from a real family', 'real customer', 'screenshot']) {
      expect(text).not.toContain(overclaim);
    }
  });

  it('gives a screen reader the whole message at once, and hides the animated copy', () => {
    // A paragraph announced one character at a time is unusable, so the sr-only
    // copy is the accessible one and both painted copies are aria-hidden.
    expect(html).toContain('<span class="sr-only">Hale: Hi, I’m Hale —');
    expect(html).toContain('<span class="v3-bubble-sizer" aria-hidden="true">');
  });

  it('renders the four reply chips as real buttons carrying the parent’s own words', () => {
    const chips = [
      ...html.matchAll(/<button type="button" class="v3-chip"[^>]*>([^<]+)<\/button>/g),
    ].map((m) => m[1]);
    expect(chips).toEqual([
      'When should Mia start solids?',
      'Watch registration dates for us',
      'What can we do Saturday morning?',
      'Is a checkup due?',
    ]);
    // Single-select, and announced as pressed state rather than by colour alone.
    expect([...html.matchAll(/aria-pressed="false"/g)]).toHaveLength(4);
  });

  it('opens on the bare greeting as the draft, so the CTA works before any chip', () => {
    expect(html).toContain('Your first text');
    expect(html).toContain('<span class="v3-draft-body">Hi</span>');
    expect(html).toContain('href="sms:+16475551234?&amp;body=Hi"');
  });

  it('makes "Text me" the sms: deep link into a pre-written first message', () => {
    // React escapes the `&` of the cross-platform `?&body=` form into `&amp;`.
    expect(html).toContain('href="sms:+16475551234?&amp;body=Hi"');
    expect(html).toContain('Text me');
  });

  it('keeps the h1 compact, gives it the serif accent, and has only one', () => {
    expect([...html.matchAll(/<h1[\s>]/g)]).toHaveLength(1);
    const h1 = html.match(/<h1[\s\S]*?<\/h1>/)?.[0] ?? '';
    expect(visibleText(h1)).toBe('Hale is a number you text — your family’s quiet chief of staff.');
    expect(h1).toContain('class="v3-accent"');
  });

  it('is a single centred column — no split hero, no phone mockup', () => {
    // A grid-cols-2 hero or a device frame would be the layout the founder
    // rejected, reintroduced.
    const hero = html.slice(html.indexOf('<h1'), html.indexOf('What I watch'));
    expect(hero).toContain('v3-thread');
    expect(hero).not.toMatch(/lg:grid-cols-\[/);
    expect(hero).not.toContain('grid-cols-2');
  });

  it('keeps a conversion surface on screen — a sticky header carrying Text Hale', () => {
    // The page once offered exactly two CTAs, 4,634px apart on desktop and 7,375px
    // apart on mobile, under a `position: static` header that held only "Sign in".
    const header = html.match(/<header[\s\S]*?<\/header>/)?.[0] ?? '';
    expect(header).toContain('sticky top-0');
    expect([...header.matchAll(/Text Hale/g)]).toHaveLength(2);
    // Split by where each half works: the composer on a phone, and on a laptop —
    // where `sms:` is dead — a scroll to the CTA block, where the copy chip lives.
    expect(header).toContain('href="sms:+16475551234?&amp;body=Hi"');
    expect(header).toContain('href="#start"');
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
    // Positive control for the assertions above: the number IS on the page,
    // invisibly, so "absent" means withheld rather than never rendered at all.
    expect(html).toContain('href="sms:+16475551234?&amp;body=Hi"');
  });

  it('offers the clipboard as the laptop path instead of the digits', () => {
    // Positive control first, so the absence below cannot pass vacuously: the copy
    // chip sits inside the CTA block the header scrolls a laptop reader to.
    const cta = html.indexOf('id="start"');
    const chip = html.indexOf('Copy my number', cta);
    expect(cta).toBeGreaterThan(-1);
    expect(chip).toBeGreaterThan(cta);
    expect(text).toContain('Copy my number');
    expect(html).not.toContain('displaySmsNumber');
  });
});

describe('landing — the brand tile, the shore, and nothing else', () => {
  const html = render();

  it('puts the logo tile in the header beside the wordmark', () => {
    const header = html.match(/<header[\s\S]*?<\/header>/)?.[0] ?? '';
    expect(header).toContain('hale-logo');
    expect(header).toMatch(/alt=""/);
    expect(header).toContain('>Hale</span>');
  });

  /**
   * The honesty pin, widened rather than dropped. The page this replaced pinned
   * "no <img> at all", which was the right rule for a page whose only picture
   * would have been a fake screenshot. This one carries two kinds of image — the
   * brand tile and one shore panel — and the rule that has to survive is the one
   * underneath it: no image on this page carries an argument. Every one is
   * decorative, from the known asset set, and none is near the conversation.
   */
  it('allows only decorative images, only from the brand set', () => {
    const imgs = html.match(/<img[^>]*>/g) ?? [];
    // Positive control: there ARE images, so the per-image assertions below are
    // checking something rather than iterating an empty list.
    expect(imgs.length).toBeGreaterThanOrEqual(3);
    for (const img of imgs) {
      expect(img, 'every image is decorative').toContain('alt=""');
      expect(img, 'every image is hidden from assistive tech').toContain('aria-hidden="true"');
      expect(img, `unexpected asset: ${img.slice(0, 90)}`).toMatch(/hale-logo|hale-shore-night/);
    }
  });

  it('keeps the conversation image-free — a message, never a picture of one', () => {
    const hero = html.slice(html.indexOf('<h1'), html.indexOf('What I watch'));
    expect(hero).not.toContain('<img');
    // Positive control: the slice really is the hero.
    expect(hero).toContain('v3-bubble');
  });

  it('closes on the shore — one panel, once — and no mascot art anywhere', () => {
    // Counted as <img> elements, not as filename occurrences: next/image emits
    // the same asset name once per srcset candidate.
    const shorePanels = (html.match(/<img[^>]*>/g) ?? []).filter((img) =>
      img.includes('hale-shore-night'),
    );
    expect(shorePanels).toHaveLength(1);
    for (const mascot of [
      'hale-turtle',
      'village-illustration',
      'diamondhead',
      'shore-ultrawide',
    ]) {
      expect(html, `${mascot} must not appear`).not.toContain(mascot);
    }
  });

  it('says the name out loud in the footer', () => {
    // The brand line every subpage carries (site-footer.tsx) and the landing once
    // dropped. Hale is Hawaiian for home; the mark is a honu. The name IS the
    // brand (home; the honu; aloha@) — it must survive every redesign.
    const footer = html.match(/<footer[\s\S]*?<\/footer>/)?.[0] ?? '';
    expect(visibleText(footer)).toContain('Hale /HAH-leh/ — Hawaiian for home.');
    expect(html).toContain('/HAH-leh/');
    expect(html).toContain('Hawaiian for home');
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

  it('keeps exactly one quiet Sign in link in the header, and one in the footer', () => {
    const header = html.match(/<header[\s\S]*?<\/header>/)?.[0] ?? '';
    expect([...header.matchAll(/\/sign-in"/g)]).toHaveLength(1);
    expect([...html.matchAll(/\/sign-in"/g)]).toHaveLength(2);
    expect(header).toContain(`href="${APP_URL}/sign-in"`);
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

  it('pins the municipality count to the Municipality union it hand-copies', () => {
    // apps/site cannot import @hale/db, so the city list in the landing component
    // is a hand-kept copy of the `Municipality` union in
    // packages/db/src/schema/registration-windows.ts. When a city is added there,
    // this count fails and the copy gets updated with it — otherwise the page
    // would quietly under-claim the coverage the radar actually has.
    expect([...html.matchAll(/class="pill pill-apricot"/g)]).toHaveLength(15);
  });

  it('watches only what registration-windows-data.ts actually holds', () => {
    // The seeded camp rows are the fall cycles and the winter-break/holiday camps.
    // There is not one March-break or summer row, and no PA-day or school-closure
    // feed exists anywhere in the product.
    expect(text).toContain('Swim lessons');
    expect(text).toContain('Camps');
    expect(text).toContain('winter-break');
    for (const invented of ['March break', 'PA day', 'PA days', 'closures']) {
      expect(text).not.toContain(invented);
    }
    expect(text).not.toMatch(/summer/i);
    // …and no school paperwork: the health timeline (checkups, immunizations) and
    // the weather read are real; school-paperwork ingestion exists nowhere.
    expect(text).not.toContain('school paperwork');
  });

  it('states the waitlist clock as the range the data holds, not one town’s 36 hours', () => {
    // waitlistResponseHours across the seed: 24 (Vaughan ×2), 36 (Toronto only),
    // 48 (Markham, Halton Hills, Oakville), null everywhere else. "The 36 hours"
    // promised every family the one value a single row carries.
    expect(text).toContain('Waitlist clocks');
    expect(text).not.toContain('The 36 hours');
  });

  it('tells the three texts and the suggest → prepare → handle ladder with receipts', () => {
    expect(text).toContain('You say hi');
    expect(text).toContain('I send your family’s radar');
    expect(text).toContain('I keep watch');
    expect(text).toContain('I suggest');
    expect(text).toContain('I prepare');
    expect(text).toContain('with your ok, I handle it');
    expect(text.toLowerCase()).toContain('receipts');
  });

  it('describes the real cadence — a Monday brief and the open-day ladder, not pure silence', () => {
    // loop_prefs defaults: weekly_plan_send_time 08:00 on users.week_start_day (1 =
    // Monday). The registration sequence adds heads_up (7 days out), battle_plan
    // (the evening before) and go (15 min prior). "Silence is the normal state"
    // described a product that never texts first, which this one does.
    expect(text).toContain('Monday morning');
    expect(text).toContain('the evening before');
    expect(text).not.toContain('Silence is the normal state');
  });

  it('offers the record by both doors a texting family actually has', () => {
    // The old line ("the full record waits in your account") was false for this
    // page's own reader: a text-provisioned family is users.email NULL +
    // external_auth_id sms:<hash> (lib/channel/intake/provision.ts), and web
    // sign-in is Google + magic link, so there was no account for them to open.
    //
    // ⚠️ The phone half of this promise is true only once claim-by-phone ("Sign in
    // with your phone" → OTP → session for the existing SMS identity) is live.
    expect(text).not.toContain('waits in your account');
    expect(text).toContain('ask me in the thread');
    expect(text).toContain('sign in with your phone number');
  });

  it('names the calendar invite as the receipt an approval actually produces', () => {
    expect(text).toContain('calendar');
    expect(text.toLowerCase()).toContain('invite');
  });

  it('covers the caregivers and the co-parent, and keeps the roles honest', () => {
    expect(text).toContain('just the schedule');
    expect(text).toContain('co-parent');
    // "Village" is reserved for the family-to-family intros product; this section
    // is about scoped caregiver access.
    expect(text).toContain('Your helpers');
  });

  it('makes the privacy claim Canadian and links the policy page', () => {
    expect(text).toContain('stays in Canada');
    expect(html).toContain('href="/privacy"');
  });

  it('carries the CASL line the composer link needs', () => {
    expect(text).toContain('You send it; I never text first');
    expect(text).toContain('reply STOP any time');
  });

  it('sends questions to the single canonical FAQ instead of duplicating it', () => {
    expect(html).toContain('href="/faq"');
  });

  it('orders the sections the way the Surfaces Plan does', () => {
    const order = [
      'quiet chief of staff',
      'What I watch',
      'How I work',
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
    // #430: the check-in day is model-chosen (checkInDays 2-5) and PROMISED in the
    // plan's own text, so the landing claims the promise, not a fixed count.
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
    // #430: plans ground on the source-verified playbooks and must name the method
    // (packages/types/src/coaching-playbooks.ts; the eval's fabrication gate holds
    // the composer to the playbook). The landing may therefore say the names — and
    // only the three the playbooks carry.
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
    // An answer engine must never describe a homepage visitors don't see. The
    // graph is rendered by the landing itself, not by the layout.
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
    expect(html).not.toContain('Text me');
    expect(html).not.toContain('647');
    // The sticky header's CTA is the same promise in miniature — with no number
    // provisioned there is nothing to offer, so it is absent rather than dead.
    expect(html).not.toContain('Text Hale');
    expect(html).not.toContain('href="#start"');
    expect(html).toContain('href="mailto:aloha@villagehale.com"');
    expect(html).toContain('The number’s coming');
  });

  it('still types the greeting and offers the chips — neither needs the number', () => {
    expect(html).toContain('v3-bubble-sizer');
    expect([...html.matchAll(/class="v3-chip"/g)]).toHaveLength(4);
  });
});
