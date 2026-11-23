import { mkdirSync, writeFileSync } from 'node:fs';
import { shareCardImage } from '~/lib/site/share-card';
import { SHARE_CARDS, type ShareCardSpec, answerShareCard } from '~/lib/site/share-cards';

const OUT = '/opt/cursor/artifacts/share-cards';

const SHEET: Array<{ file: string; label: string; spec: ShareCardSpec }> = [
  { file: 'home', label: 'Home', spec: SHARE_CARDS.home },
  { file: 'pricing', label: 'Pricing', spec: SHARE_CARDS.pricing },
  { file: 'faq', label: 'FAQ', spec: SHARE_CARDS.faq },
  { file: 'about', label: 'About', spec: SHARE_CARDS.about },
  { file: 'activities', label: 'Activities', spec: SHARE_CARDS.activities },
  {
    file: 'answers-article',
    label: 'Answers article',
    spec: answerShareCard('Newborn cluster feeding in the evening: is it normal?'),
  },
  { file: 'contact', label: 'Contact', spec: SHARE_CARDS.contact },
  { file: 'privacy', label: 'Privacy', spec: SHARE_CARDS.privacy },
  { file: 'terms', label: 'Terms', spec: SHARE_CARDS.terms },
  { file: 'not-found', label: '404', spec: SHARE_CARDS['not-found'] },
];

mkdirSync(OUT, { recursive: true });

for (const card of SHEET) {
  const response = shareCardImage(card.spec);
  const bytes = Buffer.from(await response.arrayBuffer());
  writeFileSync(`${OUT}/${card.file}.png`, bytes);
  console.info(card.file, bytes.length);
}

console.info('wrote', SHEET.length);
