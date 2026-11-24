import { SITE_URL } from '~/lib/app-url';
import { ONE_LINER, PAGE_TITLE } from '~/lib/site/narrative';

/**
 * Words painted on the 1200×630 share cards. English on every locale: the
 * image is one file, and CA and US prices are never drawn on it.
 */
export interface ShareCardSpec {
  id: string;
  alt: string;
  eyebrow?: string;
  headline: string;
  subline?: string;
  /** Home and pricing only: the iMessage group-chat mock on the right third. */
  chat?: boolean;
}

export const SHARE_CARD_SIZE = { width: 1200, height: 630 } as const;

export const SHARE_CARDS = {
  home: {
    id: 'home',
    alt: PAGE_TITLE,
    headline: PAGE_TITLE,
    subline: ONE_LINER,
    chat: true,
  },
  pricing: {
    id: 'pricing',
    alt: `Hale pricing. ${ONE_LINER}`,
    eyebrow: 'PRICING',
    headline: PAGE_TITLE,
    subline: ONE_LINER,
    chat: true,
  },
  faq: {
    id: 'faq',
    alt: 'FAQ. Straight answers about Hale.',
    eyebrow: 'FAQ',
    headline: 'Straight answers about Hale.',
    subline: 'What it does, what it reads, and why it never acts without your ok.',
  },
  about: {
    id: 'about',
    alt: 'About Hale. Built by a dad with an invisible list.',
    eyebrow: 'ABOUT',
    headline: 'Built by a dad with an invisible list.',
    subline: ONE_LINER,
  },
  activities: {
    id: 'activities',
    alt: 'Things to do with kids, near you. Text Hale.',
    eyebrow: 'THINGS TO DO',
    headline: 'Things to do with kids, near you.',
    subline: 'Text Hale and it finds 2–3 that fit your kid this week.',
  },
  answers: {
    id: 'answers',
    alt: 'Hale parenting guides.',
    eyebrow: 'PARENTING GUIDES',
    headline: 'Parenting guides',
  },
  contact: {
    id: 'contact',
    alt: `Contact Hale. ${PAGE_TITLE}`,
    eyebrow: 'CONTACT',
    headline: PAGE_TITLE,
  },
  privacy: {
    id: 'privacy',
    alt: `Hale privacy policy. ${PAGE_TITLE}`,
    eyebrow: 'PRIVACY',
    headline: PAGE_TITLE,
  },
  terms: {
    id: 'terms',
    alt: `Hale terms of service. ${PAGE_TITLE}`,
    eyebrow: 'TERMS',
    headline: PAGE_TITLE,
  },
  'not-found': {
    id: 'not-found',
    alt: `Page not found. ${PAGE_TITLE}`,
    eyebrow: 'NOT FOUND',
    headline: PAGE_TITLE,
  },
  text: {
    id: 'text',
    alt: `Text Hale. ${PAGE_TITLE}`,
    eyebrow: 'TEXT',
    headline: PAGE_TITLE,
  },
} as const satisfies Record<string, ShareCardSpec>;

export type ShareCardId = keyof typeof SHARE_CARDS;

export function isShareCardId(value: string): value is ShareCardId {
  return Object.hasOwn(SHARE_CARDS, value);
}

export function shareCardUrl(id: string): string {
  return `${SITE_URL}/og/${id}`;
}

export function shareCardImage(id: ShareCardId) {
  const card = SHARE_CARDS[id];
  return {
    url: shareCardUrl(id),
    ...SHARE_CARD_SIZE,
    alt: card.alt,
  };
}

/** Article cards reuse the parenting-guides template. The title is the headline. */
export function answerShareCard(title: string): ShareCardSpec {
  return {
    id: 'answer',
    alt: `Hale parenting guide: ${title}`,
    eyebrow: 'PARENTING GUIDES',
    headline: title,
  };
}

export function answerShareImage(slug: string, title: string) {
  return {
    url: `${SITE_URL}/og/answers/${slug}`,
    ...SHARE_CARD_SIZE,
    alt: answerShareCard(title).alt,
  };
}
