import { HOME_SLOGAN, defaultShareQuery, paintShareCard } from '~/lib/site/share-cards';

/**
 * Homepage share-card words. The painted card and its alt live in share-cards.ts
 * so every page uses one template.
 */
export interface SocialCardCopy {
  alt: string;
  headline: string;
  subline: string;
}

export function socialCardCopy(): SocialCardCopy {
  const home = paintShareCard('home', defaultShareQuery('en'));
  return {
    alt: home.alt,
    headline: HOME_SLOGAN.en.plain,
    subline: '',
  };
}
