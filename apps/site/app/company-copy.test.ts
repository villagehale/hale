import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import AboutPage from './[locale]/about/page.js';
import ContactPage from './[locale]/contact/page.js';

const LOCALES = ['en', 'fr', 'zh'] as const;

const FINAL_COPY = {
  en: {
    about:
      'Hale is made by Village Hale Technologies Inc. in Georgetown, Ontario. A real person reads every note.',
    contact:
      'Hale is built by parents, and a real person reads what you send. Email is the fastest way to reach us.',
    audience:
      'Hale is for parents and caregivers in the US and Canada with kids from newborn to 18: the parent who keeps the family calendar, co-parents who share the load, and groups of parents planning together.',
  },
  fr: {
    about:
      'Hale est conçu par Village Hale Technologies Inc., à Georgetown, en Ontario. Une vraie personne lit chaque message.',
    contact:
      'Hale est fait par des parents, et une vraie personne lit ce que tu envoies. Le courriel est le plus rapide.',
    audience:
      'Hale s’adresse aux parents et aux proches aidants aux États-Unis et au Canada qui ont des enfants de la naissance à 18 ans : le parent qui tient le calendrier familial, les coparents qui partagent la charge et les groupes de parents qui planifient ensemble.',
  },
  zh: {
    about:
      'Hale 由安大略省 Georgetown 的 Village Hale Technologies Inc. 打造。每条留言都有真人看。',
    contact: 'Hale 是父母做的，你发来的每条都有真人看。发邮件最快。',
    audience:
      'Hale 面向美国和加拿大有 0 到 18 岁孩子的家长和照顾者：管家庭日程的那位家长、分担家务的另一半，以及一起做计划的家长群。',
  },
} as const;

const OLD_WORDING =
  /small and early|small, parent-built|just getting started|On est petits|tout au début|Nous débutons|我们人少|也还早|刚刚起步/;

function visibleText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');
}

describe.each(LOCALES)('company lines on About and Contact (%s)', (locale) => {
  const page = { params: Promise.resolve({ locale }) };

  it('says who makes Hale and that a real person reads, without calling Hale small or early', async () => {
    const about = visibleText(renderToStaticMarkup(await AboutPage(page)));
    const contact = visibleText(renderToStaticMarkup(await ContactPage(page)));

    expect(about).toContain(FINAL_COPY[locale].about);
    expect(about).toContain(FINAL_COPY[locale].audience);
    expect(contact).toContain(FINAL_COPY[locale].contact);
    expect(about).not.toMatch(OLD_WORDING);
    expect(contact).not.toMatch(OLD_WORDING);
  });
});
