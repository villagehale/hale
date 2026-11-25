import { mkdirSync, writeFileSync } from 'node:fs';
import { allAnswers } from '~/lib/answers/index';
import { renderShareCard } from '~/lib/site/share-card';
import {
  SHARE_CARD_IDS,
  type ShareCardQuery,
  paintAnswerCard,
  paintShareCard,
} from '~/lib/site/share-cards';

const OUT = '/tmp/og-preview';
mkdirSync(OUT, { recursive: true });

function query(partial: Partial<ShareCardQuery>): ShareCardQuery {
  return {
    locale: 'en',
    phase: 'black_friday',
    currency: 'CAD',
    offer: true,
    paid: false,
    ...partial,
  };
}

const jobs: Array<{ file: string; card: ReturnType<typeof paintShareCard> }> = [];

for (const phase of ['black_friday', 'holiday'] as const) {
  for (const id of SHARE_CARD_IDS) {
    jobs.push({
      file: `${id}-${phase}-en`,
      card: paintShareCard(id, query({ phase, paid: id === 'checkout' })),
    });
  }
  jobs.push({
    file: `home-${phase}-fr`,
    card: paintShareCard('home', query({ phase, locale: 'fr' })),
  });
  jobs.push({
    file: `home-${phase}-zh`,
    card: paintShareCard('home', query({ phase, locale: 'zh', currency: 'USD' })),
  });
  jobs.push({
    file: `faq-${phase}-fr`,
    card: paintShareCard('faq', query({ phase, locale: 'fr' })),
  });
  jobs.push({
    file: `about-${phase}-zh`,
    card: paintShareCard('about', query({ phase, locale: 'zh' })),
  });
}

const long = allAnswers.slice().sort((a, b) => b.question.length - a.question.length)[0];
if (long) {
  jobs.push({
    file: 'answer-long-en',
    card: paintAnswerCard(long.question, query({ phase: 'holiday' })),
  });
}

for (const job of jobs) {
  const response = renderShareCard(job.card);
  const bytes = Buffer.from(await response.arrayBuffer());
  writeFileSync(`${OUT}/${job.file}.png`, bytes);
  console.info(job.file, bytes.length);
}

console.info('wrote', jobs.length, 'to', OUT);
