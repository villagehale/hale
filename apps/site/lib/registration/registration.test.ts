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
    guide.h1.map((s) => s.text).join(' '),
    guide.lede,
    guide.datesHeading.map((s) => s.text).join(' '),
    guide.dateNote,
    ...guide.dateRows.map((row) => `${row.when} ${row.what}`),
    ...guide.officialUrls.map((u) => `${u.href} ${u.label}`),
    ...guide.ruleCards.flatMap((card) => [card.tag, card.title, card.line, ...card.checks]),
    ...guide.sections.flatMap((section) => [
      section.headline.map((s) => s.text).join(' '),
      section.lede ?? '',
      ...section.paragraphs,
      ...(section.bullets ?? []),
      ...(section.groups ?? []).flatMap((group) => [group.title, ...group.items]),
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

function requireGuide(slug: string) {
  const guide = getGuide(slug);
  if (!guide) throw new Error(`missing guide ${slug}`);
  return guide;
}

describe('the rules that make parents miss', () => {
  it('teaches Toronto that the district is the centre, not the home address', () => {
    const text = allText(requireGuide('toronto-fall-recreation-registration'));
    expect(text.toLowerCase()).toContain('leslieville');
    expect(text).toContain('Sept 16');
    expect(text.toLowerCase()).toContain('welcome policy');
    expect(text).toContain('36');
    expect(text.toLowerCase()).toContain('efun');
  });

  it('says Toronto swim is the same morning as rec, not a separate day', () => {
    const text = allText(requireGuide('toronto-swim-registration'));
    expect(text.toLowerCase()).toContain('not a separate day');
    expect(text).toContain('Ultra');
    expect(text).toContain('Guardian');
    expect(text.toLowerCase()).toContain('not red cross');
    expect(text.toLowerCase()).toContain('not ymca otter');
  });

  it('says Brampton swim is September 9, not the August 24 rec open', () => {
    const text = allText(requireGuide('brampton-swim-registration'));
    expect(text).toContain('September 9');
    expect(text).toContain('August 24');
    expect(text).toContain('24');
    expect(text.toLowerCase()).toContain('in person');
    expect(text.toLowerCase()).toContain('account & residency validated');
  });

  it('sells Brampton Hale as kids-only watch, not adult Learn to Swim', () => {
    const guide = requireGuide('brampton-swim-registration');
    const sell = `${guide.lede}\n${guide.ctaSub}`;
    expect(sell).toContain("Hale watches kids' swim for parents.");
    expect(sell).toContain('Adult lessons stay on the city page.');
    expect(sell).toContain("Text your kids' names, ages, and postal and I'll watch Sept 9.");
    expect(sell).toContain('Founding families free.');
    expect(sell).not.toContain('Hale will text you the night before');
    expect(sell).not.toMatch(/Hale will run/i);
    // City facts stay; Hale does not claim adult Learn to Swim.
    expect(guide.lede).toContain('Aug 24');
    expect(guide.lede).toContain('Sept 9');
    expect(guide.smsPrefill).toBe('Hi Hale');
  });

  it('keeps YMCA on My Y at 9 a.m. with a membership gate', () => {
    const text = allText(requireGuide('ymca-gta-swim-registration'));
    expect(text).toContain('August 27');
    expect(text).toContain('9');
    expect(text.toLowerCase()).toContain('membership');
    expect(text.toLowerCase()).toContain('myy');
    expect(text.toLowerCase()).toContain('otter');
  });
});
