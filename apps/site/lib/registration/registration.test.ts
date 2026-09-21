import { describe, expect, it } from 'vitest';
import { REGISTRATION_GUIDES, getGuide } from './index';

const SLUGS = [
  'toronto-fall-recreation-registration',
  'toronto-swim-registration',
  'brampton-swim-registration',
  'ymca-gta-swim-registration',
] as const;

const HELD_BACK = [
  '/york-region-swim-registration',
  '/vaughan-recreation-registration',
  '/vaughan-swim-registration',
  '/mississauga-swim-registration',
] as const;

function allText(guide: (typeof REGISTRATION_GUIDES)[number]): string {
  const parts = [
    guide.title,
    guide.description,
    guide.eyebrow,
    guide.h1.map((s) => s.text).join(' '),
    guide.lede,
    guide.datesEyebrow,
    guide.datesHeading.map((s) => s.text).join(' '),
    guide.dateNote,
    ...guide.dateRows.map((row) => `${row.when} ${row.what}`),
    ...guide.officialUrls.map((u) => `${u.href} ${u.label}`),
    guide.rulesEyebrow,
    guide.rulesHeading.map((s) => s.text).join(' '),
    ...guide.ruleCards.flatMap((card) => [
      card.tag,
      card.title,
      card.line,
      card.linkLabel ?? '',
      ...card.checks,
    ]),
    ...guide.sections.flatMap((section) => [
      section.headline.map((s) => s.text).join(' '),
      section.lede ?? '',
      ...section.paragraphs,
      ...(section.bullets ?? []),
      ...(section.groups ?? []).flatMap((group) => [group.title, ...group.items]),
      ...(section.links ?? []).map((link) => link.label),
    ]),
    ...guide.faqs.flatMap((faq) => [faq.question, faq.answer]),
    guide.ctaHeading,
    guide.ctaSub,
    guide.unofficialNote,
    guide.footerNote,
  ];
  return parts.join('\n');
}

describe('city registration guides', () => {
  it('ships exactly the four English routes, in brief order', () => {
    expect(REGISTRATION_GUIDES.map((g) => g.slug)).toEqual([...SLUGS]);
  });

  it('gives every guide a unique path matching its slug', () => {
    for (const guide of REGISTRATION_GUIDES) {
      expect(guide.path).toBe(`/${guide.slug}`);
      expect(getGuide(guide.slug)).toBe(guide);
    }
  });

  it('names city, action, and year in the H1 — never a complete-guide pitch', () => {
    for (const guide of REGISTRATION_GUIDES) {
      const h1 = guide.h1.map((s) => s.text).join(' ');
      expect(h1.toLowerCase()).not.toContain('complete guide');
      expect(`${guide.title} ${h1} ${guide.eyebrow}`).toMatch(/2026|August 27/);
      expect(guide.h1.filter((s) => s.accent === true)).toHaveLength(1);
    }
  });

  it('keeps Toronto fall-rec and Toronto swim on distinct titles and H1s', () => {
    const fall = getGuide('toronto-fall-recreation-registration');
    const swim = getGuide('toronto-swim-registration');
    expect(fall?.title).not.toBe(swim?.title);
    expect(fall?.h1.map((s) => s.text).join(' ')).not.toBe(swim?.h1.map((s) => s.text).join(' '));
    expect(fall?.title.toLowerCase()).toContain('dates by district');
    expect(
      swim?.h1
        .map((s) => s.text)
        .join(' ')
        .toLowerCase(),
    ).toContain('not a separate day');
  });

  it('puts YMCA in the YMCA title and H1 so it cannot rank as toronto swim registration', () => {
    const ymca = getGuide('ymca-gta-swim-registration');
    expect(ymca?.title).toMatch(/YMCA/);
    expect(ymca?.h1.map((s) => s.text).join(' ')).toMatch(/YMCA/);
  });

  it('does not ship the held-back city routes', () => {
    const paths = REGISTRATION_GUIDES.map((g) => g.path);
    for (const held of HELD_BACK) {
      expect(paths).not.toContain(held);
    }
  });

  it('carries 4–5 parent-language FAQ questions and official register URLs', () => {
    for (const guide of REGISTRATION_GUIDES) {
      expect(guide.faqs.length).toBeGreaterThanOrEqual(4);
      expect(guide.faqs.length).toBeLessThanOrEqual(5);
      expect(guide.officialUrls.length).toBeGreaterThan(0);
      expect(guide.dateRows.length).toBeGreaterThan(0);
      expect(guide.updated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('never prints a Hale phone number, SMS number, or a 416/905/647 text-this-number', () => {
    for (const guide of REGISTRATION_GUIDES) {
      const text = allText(guide);
      expect(text).not.toMatch(/\b(416|905|647)[\s.-]?\d{3}[\s.-]?\d{4}\b/);
      expect(text).not.toMatch(/\+1\s*\(?\s*(416|905|647)/);
      expect(text.toLowerCase()).not.toContain('sms:');
      expect(text.toLowerCase()).not.toContain('copy number');
    }
  });

  it('stays off parenting, weekend roundups, and the answers corpus', () => {
    for (const guide of REGISTRATION_GUIDES) {
      const text = allText(guide).toLowerCase();
      expect(text).not.toContain('/answers');
      expect(text).not.toContain('tantrum');
      expect(text).not.toContain('is my child ready');
      expect(text).not.toMatch(/^this weekend/m);
      expect(text).not.toContain('this weekend');
    }
  });

  it('says Hale is unofficial and names founding families', () => {
    for (const guide of REGISTRATION_GUIDES) {
      const text = allText(guide);
      expect(text.toLowerCase()).toContain('unofficial');
      expect(text.toLowerCase()).toContain('founding');
    }
  });

  it('points founding families at villagehale.com on the guides that still sell that way', () => {
    for (const guide of REGISTRATION_GUIDES.filter(
      (g) => g.slug !== 'brampton-swim-registration',
    )) {
      expect(allText(guide)).toContain('villagehale.com');
    }
  });
});

/**
 * The mornings of the 2026 fall cycle that are behind us, and the ones that are
 * not. The audit of 2026-09-17 found every guide still reading as though Sept 9,
 * 15 and 16 were coming — "Brampton swim registration is September 9", "I'll
 * watch Sept 9" — eight days after the last of them. Prose cannot be dated by a
 * test, but tense can: a morning in this list may only ever appear in a sentence
 * that says it has gone. When the cycle turns, this list moves with the copy.
 */
const PASSED_MORNINGS = [
  'Aug 24',
  'August 24',
  'Aug 27',
  'August 27',
  'Sept 9',
  'September 9',
  'Sept 14',
  'Sept 15',
  'Sept 16',
] as const;

/** Verbs that put a date in the past. Bare "open" is deliberately absent — it is
 * the word every rotted sentence used, and so is "never": "registration opens
 * Sept 9, never later" is a future claim wearing a past-tense word. */
const PAST_TENSE =
  /\b(passed|gone|opened|went|moved|got|was|were|already|behind|ran|started|staffed|closed|published|record)\b/i;

function sentences(text: string): string[] {
  return text
    .split(/\n|(?<=[.;!?])\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function requireGuide(slug: string) {
  const guide = getGuide(slug);
  if (!guide) throw new Error(`missing guide ${slug}`);
  return guide;
}

describe('the season these pages are written for', () => {
  it('names a morning that has gone only in a sentence that says so', () => {
    for (const guide of REGISTRATION_GUIDES) {
      for (const sentence of sentences(allText(guide))) {
        const named = PASSED_MORNINGS.filter((morning) => sentence.includes(morning));
        if (named.length === 0) continue;
        expect(
          sentence,
          `${guide.slug} writes ${named.join(', ')} as though it were still ahead`,
        ).toMatch(PAST_TENSE);
      }
    }
  });

  it('still carries those mornings as the record, rather than deleting them', () => {
    // Otherwise the tense gate above passes by having nothing left to say — a
    // parent searching "brampton swim september 9" must still land on the answer.
    const everything = REGISTRATION_GUIDES.map(allText).join('\n');
    for (const morning of ['Aug 24', 'Sept 9', 'Sept 15', 'Sept 16', 'August 27']) {
      expect(everything).toContain(morning);
    }
  });
});

describe('the rules that make parents miss', () => {
  it('teaches Toronto that the district is the centre, not the home address', () => {
    const guide = requireGuide('toronto-fall-recreation-registration');
    const text = allText(guide);
    expect(text.toLowerCase()).toContain('leslieville');
    expect(text).toContain('Sept 16');
    expect(text.toLowerCase()).toContain('welcome policy');
    expect(text).toContain('36');
    expect(text.toLowerCase()).toContain('efun');
    // The district also decides the one Toronto morning still ahead, but the date
    // itself comes from the dataset, not from this page's arithmetic.
    expect(guide.dateRows[0]?.when).toContain('Sept 25');
    expect(text.toLowerCase()).toContain('ten days');
  });

  it('says Toronto swim is the same morning as rec, not a separate day', () => {
    const guide = requireGuide('toronto-swim-registration');
    const text = allText(guide);
    expect(text.toLowerCase()).toContain('not a separate day');
    expect(text).toContain('Ultra');
    expect(text).toContain('Guardian');
    expect(text.toLowerCase()).toContain('not red cross');
    expect(text.toLowerCase()).toContain('not ymca otter');
    // What a parent arriving after the mornings can still do: the non-resident
    // open, and the city's own third-class rule.
    expect(guide.lede).toContain('Sept 25');
    expect(text.toLowerCase()).toContain('third class');
  });

  /**
   * Toronto prints only the resident morning; the non-resident open is the city's
   * ten-day rule applied to it, and the one date any Hale source carries for it is
   * Sept 25 — the registration dataset's `openAt`, and what the SMS twin texts.
   * Running the rule a second time to print Sept 26 for the districts that opened
   * Sept 16 puts a date on the page that no source prints and that the text message
   * contradicts (VIL-334). The rule may be taught; the arithmetic may not be done
   * here.
   */
  it('prints one Toronto non-resident morning — the rule, never a second derived date', () => {
    for (const slug of ['toronto-fall-recreation-registration', 'toronto-swim-registration']) {
      const guide = requireGuide(slug);
      const text = allText(guide);
      expect(text).toContain('Sept 25');
      expect(text.toLowerCase()).toContain('ten days');
      for (const sentence of sentences(text)) {
        if (!/non-resident/i.test(sentence)) continue;
        expect(
          sentence,
          `${slug} derives a second non-resident morning the dataset does not carry`,
        ).not.toMatch(/Sept(ember)? 26/);
      }
    }
    // Positive control, so the gate above cannot pass by the page having deleted
    // Sept 26 outright: the city DID print it, as the week programming begins.
    expect(allText(requireGuide('toronto-fall-recreation-registration'))).toContain(
      'Week of Sept 26',
    );
  });

  it('says the winter cycle is not posted, on both cities that publish a look-ahead', () => {
    const toronto = allText(requireGuide('toronto-fall-recreation-registration'));
    expect(toronto.toLowerCase()).toContain('not posted');
    // Toronto's look-ahead stays a look-ahead — browse/register windows, no 7 a.m.
    expect(toronto).toContain('Nov 17');
    expect(toronto).toContain('Dec 1');
    expect(toronto).not.toMatch(/Nov 17[^.]{0,40}7 a\.m\./);
    expect(allText(requireGuide('brampton-swim-registration')).toLowerCase()).toContain(
      'not posted',
    );
  });

  it('keeps Brampton’s Sept 9 and Aug 24 as record while leading with Sept 21', () => {
    const guide = requireGuide('brampton-swim-registration');
    const text = allText(guide);
    expect(text).toContain('September 9');
    expect(text).toContain('August 24');
    expect(text).toContain('24');
    expect(text.toLowerCase()).toContain('in person');
    expect(text.toLowerCase()).toContain('account & residency validated');
    // The morning still ahead is what the page leads with, everywhere a parent
    // looks first: the headline, the first dates row, and the closing ask.
    expect(guide.h1.map((s) => s.text).join(' ')).toContain('Sept 21');
    expect(guide.dateRows[0]?.when).toContain('Sept 21');
    expect(guide.ctaHeading).toContain('Sept 21');
  });

  it('sells Brampton Hale as kids-only watch, not adult Learn to Swim', () => {
    const guide = requireGuide('brampton-swim-registration');
    const sell = `${guide.lede}\n${guide.ctaSub}`;
    expect(sell).toContain("Hale watches kids' swim for parents.");
    expect(sell).toContain('Adult lessons stay on the city page.');
    expect(sell).toContain("Text your kids' names, ages, and postal and I'll watch Sept 21.");
    expect(sell).toContain('Founding families free.');
    expect(sell).not.toContain('Hale will text you the night before');
    expect(sell).not.toMatch(/Hale will run/i);
    // City facts stay; Hale does not claim adult Learn to Swim. Sept 9 stays on
    // the page as the residents' record, never as the morning Hale will watch.
    expect(guide.lede).toContain('Sept 9');
    expect(guide.lede).toContain('Sept 21');
    expect(guide.smsPrefill).toBe("What is worth doing with the kids near us?");
  });

  it('keeps YMCA on My Y at 9 a.m. with a membership gate', () => {
    const guide = requireGuide('ymca-gta-swim-registration');
    const text = allText(guide);
    expect(text).toContain('August 27');
    expect(text).toContain('9');
    expect(text.toLowerCase()).toContain('membership');
    expect(text.toLowerCase()).toContain('myy');
    expect(text.toLowerCase()).toContain('otter');
    // The open is a record now; the listing window Hale read is what is left.
    expect(guide.lede).toContain('Oct 10');
    expect(guide.dateRows[0]?.when).toContain('Oct 10');
  });
});
