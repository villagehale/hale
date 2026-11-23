import type { ReactNode } from 'react';
import type { Locale } from '~/i18n/routing';
import fr from '../../messages/fr.json';
import zh from '../../messages/zh.json';

type Dict = Record<string, string>;

const DICTS: Record<'fr' | 'zh', Dict> = {
  fr: (fr as { Rd?: Dict }).Rd ?? {},
  zh: (zh as { Rd?: Dict }).Rd ?? {},
};

const missing = new Map<'fr' | 'zh', Set<string>>();

/** English copy is the key. French and Chinese live in the locale message files. */
export function tx(locale: Locale, english: string): string {
  if (locale === 'en') return english;
  const value = DICTS[locale][english];
  if (!value) {
    const bag = missing.get(locale) ?? new Set<string>();
    bag.add(english);
    missing.set(locale, bag);
    throw new Error(`Missing ${locale} translation: ${english}`);
  }
  return value;
}

export function missingRd(locale: 'fr' | 'zh'): string[] {
  return [...(missing.get(locale) ?? [])].sort();
}

/** A sentence with one phrase linked, in whatever order the translation uses. */
export function Phrase({
  locale,
  sentence,
  phrase,
  href,
  className = 'hs-link',
}: {
  locale: Locale;
  sentence: string;
  phrase: string;
  href?: string;
  className?: string;
}): ReactNode {
  const text = tx(locale, sentence);
  const bit = tx(locale, phrase);
  const at = text.indexOf(bit);
  if (at < 0) return text;
  const linked = href ? (
    <a className={className} href={href}>
      {bit}
    </a>
  ) : (
    <span className={className}>{bit}</span>
  );
  return (
    <>
      {text.slice(0, at)}
      {linked}
      {text.slice(at + bit.length)}
    </>
  );
}
