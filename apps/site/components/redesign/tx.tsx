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

const CLOSE_LEADS = ['Founding families', 'Les familles fondatrices', '创始家庭'];

/** Keeps the founding-family name on one line of the closing heading. */
export function closeHeading(text: string): ReactNode {
  const lead = CLOSE_LEADS.find((item) => text.startsWith(item));
  if (!lead) return text;
  return (
    <>
      <span className="hs-keep">{lead}</span>
      {text.slice(lead.length)}
    </>
  );
}

const CARD_TAILS = [/in one go$/, /d['’]un coup$/, /一次办完$/];

/** Keeps the last words of the Max feature on the same line. */
export function keepCardTail(text: string): ReactNode {
  const tail = CARD_TAILS.find((pattern) => pattern.test(text));
  const match = tail ? text.match(tail)?.[0] : undefined;
  if (!match) return text;
  return (
    <>
      {text.slice(0, text.length - match.length)}
      <span className="hs-keep">{match}</span>
    </>
  );
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
