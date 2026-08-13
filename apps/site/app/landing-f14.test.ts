import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { APP_URL } from '~/lib/app-url.js';
import { F14_LANDING_ENV } from '~/lib/flags/landing.js';
import { impactNumbers } from '~/lib/landing/impact.js';
import LandingPage from './page.js';

/**
 * VIL-250 · M14 — the persona-led landing pivot (D20/D21), behind
 * NEXT_PUBLIC_F14_LANDING. Dark: with the flag off the homepage is today's
 * village landing, which app/page.test.ts asserts in full against the
 * unmodified suite. This file owns the flag matrix and the flag-on page.
 *
 * The pivot's whole argument is that the only way in is texting Hale, so the
 * strongest assertions here are the negative ones: no signup funnel, no
 * capability claimed that isn't live, no placeholder metrics.
 */

const LIVE_NUMBER = '+16475551234';

/** The flag-on homepage, rendered with the number provisioned (the flip state). */
function renderOn({ number = LIVE_NUMBER }: { number?: string } = {}): string {
  vi.stubEnv(F14_LANDING_ENV, 'true');
  vi.stubEnv('NEXT_PUBLIC_HALE_SMS_NUMBER', number);
  return renderToStaticMarkup(createElement(LandingPage));
}

/** Visible text, tag-stripped — the village hero reveals word-by-word, one span each. */
function visibleText(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('homepage flag matrix', () => {
  it('serves today’s village landing when the flag is unset', () => {
    vi.stubEnv(F14_LANDING_ENV, '');
    const html = renderToStaticMarkup(createElement(LandingPage));
    expect(visibleText(html)).toContain('Parenting was never meant to be done alone.');
    expect(html).not.toContain('quiet chief of staff');
  });

  it('serves the chief-of-staff landing only for the exact literal', () => {
    for (const value of ['true\n', 'True', '1']) {
      vi.stubEnv(F14_LANDING_ENV, value);
      const html = renderToStaticMarkup(createElement(LandingPage));
      expect(visibleText(html)).toContain('Parenting was never meant to be done alone.');
      expect(html).not.toContain('quiet chief of staff');
    }
    expect(renderOn()).toContain('quiet chief of staff');
  });
});

describe('flag-on landing (hero)', () => {
  const html = renderOn();

  it('leads with the persona hero, verbatim', () => {
    expect(html).toContain('Hi, I’m Hale — your family’s quiet chief of staff.');
    expect(html).toContain(
      'I keep watch over your week — registrations, programs, checkups, weather — and text you before things matter.',
    );
  });

  it('names only watched things that exist — no school paperwork Hale cannot see', () => {
    // The health timeline (checkups, immunizations) and the weather read are real;
    // there is no school-paperwork ingestion anywhere in the product.
    expect(html).not.toContain('school paperwork');
  });

  it('has exactly one h1', () => {
    expect([...html.matchAll(/<h1[\s>]/g)]).toHaveLength(1);
  });

  it('makes "Text me" the sms: deep link into a pre-written first message', () => {
    // React escapes the `&` of the cross-platform `?&body=` form into `&amp;`.
    expect(html).toContain('href="sms:+16475551234?&amp;body=Hi"');
    expect(html).toContain('Text me');
  });

  it('covers desktop, where sms: links are dead, with the number and a scannable QR', () => {
    expect(html).toContain('+1 (647) 555-1234');
    expect(html).toContain('aria-label="QR code — scan to text Hale"');
  });
});

describe('flag-on landing (number not provisioned)', () => {
  const html = renderOn({ number: '' });

  it('never renders a dead sms: link or a number that cannot be texted', () => {
    expect(html).not.toContain('sms:');
    expect(html).not.toContain('Text me');
    expect(html).not.toContain('647');
  });

  it('falls back to the honest email path and says the number is not live', () => {
    expect(html).toContain('href="mailto:aloha@villagehale.com"');
    expect(html).toContain('The number’s coming');
  });
});

describe('flag-on landing (no signup funnel — the only way in is texting Hale)', () => {
  const html = renderOn();

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
});

describe('flag-on landing (sections, in the Surfaces Plan order)', () => {
  const html = renderOn();
  const text = html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

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
    // apps/site cannot import @hale/db, so the city list in chief-of-staff.tsx is a
    // hand-kept copy of the `Municipality` union in
    // packages/db/src/schema/registration-windows.ts. When a city is added there,
    // this count fails and the copy gets updated with it — otherwise the page would
    // quietly under-claim the coverage the radar actually has.
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
    // The old line ("the full record waits in your account") was false for this page's
    // own reader: a text-provisioned family is users.email NULL + external_auth_id
    // sms:<hash> (lib/channel/intake/provision.ts), and web sign-in is Google + magic
    // link, so there was no account for them to open.
    //
    // ⚠️ MERGE ORDER: the phone half of this promise is true only once claim-by-phone
    // ("Sign in with your phone" → OTP → session for the existing SMS identity) is
    // live. It is NOT on main as of this commit. Do not flip NEXT_PUBLIC_F14_LANDING
    // until it is, or this line re-becomes the falsehood it replaced.
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

  it('offers the founding rate without inventing urgency', () => {
    expect(text).toContain('Founding families');
    for (const pressure of ['Only', 'spots left', 'Hurry', 'ends soon', 'Limited time']) {
      expect(text).not.toContain(pressure);
    }
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

describe('flag-on landing (parenting coaching — the answer, the plan, the check-in)', () => {
  const text = renderOn()
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

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

describe('flag-on landing (structured data)', () => {
  it('emits its own JSON-LD graph — the flag-branched copy was never rendered', () => {
    // siteJsonLd() has branched on the flag since the launch-day review, but only
    // VillageLanding ever rendered the script tag, so the F14 homepage shipped with
    // no structured data at all and the chief-of-staff branch was dead code.
    const html = renderOn();
    expect(html).toContain('application/ld+json');
    expect(html).toContain('A number your family texts');
    expect(html).not.toContain('passive household assistant');
  });
});

describe('flag-on landing (impact numbers — honesty rule)', () => {
  it('has no metrics wired yet, so the band is omitted rather than zeroed', () => {
    expect(impactNumbers()).toBeNull();
    const text = renderOn()
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ');
    for (const label of ['families covered', 'registrations caught', 'weeks planned']) {
      expect(text).not.toContain(label);
    }
  });
});

describe('flag-on landing (the transcript is the real script)', () => {
  const html = renderOn();

  it('plays the first-10-minutes script from the Conversation Design book (v2, 2026-08-11)', () => {
    expect(html).toContain(
      'Hi, I’m Hale — an AI that quietly runs the family week. Registration dates, weekend plans, the stuff that slips.',
    );
    // v2 folded the AI disclosure into the greeting itself; the old parenthetical
    // disclaimer must be gone, and the privacy link now rides the consent moment.
    expect(html).not.toContain('I’m an assistant, not a person');
    expect(html).toContain('how I handle your family’s info: villagehale.com/privacy');
    expect(html).toContain('Max is 4, Mia is 18 months, L4C');
    expect(html).toContain(
      'Mark this: Richmond Hill fall swim registration opens Tue Aug 12 at 7am',
    );
    expect(html).toContain(
      'Done — you’re covered. I only text when something actually matters, and STOP always',
    );
    expect(html).toContain('what part of the week wears you out the most?');
  });

  it('labels the thread as an example rather than passing it off as a screenshot', () => {
    expect(html.toLowerCase()).toContain('example');
    expect(html).not.toContain('<img');
  });
});
