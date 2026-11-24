import { type FamilyStage, PROMO_PRICE_DISPLAY } from '@hale/types';
import { publishedAnswers } from '~/lib/answers/index';
import { SITE_URL } from '~/lib/app-url';
import { REFUND_LINE } from '~/lib/billing/plain-price';
import { ONE_LINER, PLUS_SIGNUP_LINE } from '~/lib/site/narrative';

/**
 * /llms.txt — the emerging convention for telling AI assistants what a site is
 * and which pages are worth citing. Generated from `publishedAnswers`, so it can
 * only ever list human-reviewed pages: a held draft is absent here for the same
 * reason it is noindexed and out of the sitemap. Served as text/plain.
 */

export const dynamic = 'force-static';

// The stages, in the order the corpus reads (0–18), each with its section label.
const STAGE_SECTIONS: { stage: FamilyStage; label: string }[] = [
  { stage: 'newborn', label: 'Newborn (0–11 months)' },
  { stage: 'toddler', label: 'Toddler (1–3 years)' },
  { stage: 'preschool', label: 'Preschool (4 years)' },
  { stage: 'child', label: 'School age (5–12 years)' },
  { stage: 'teenager', label: 'Teenager (13+ years)' },
];

function buildLlmsTxt(): string {
  const lines: string[] = [
    '# Hale',
    '',
    `> ${ONE_LINER} ${PLUS_SIGNUP_LINE} For every stage of childhood (0–18). Its answer pages give calm, plain answers to the parenting-health questions families search for — each one grounded in trusted, cited frameworks (Canadian Paediatric Society, Health Canada, American Academy of Pediatrics, and named parenting authors) and honest that it is general guidance, never a substitute for a family's own health provider.`,
    '',
    '## About Hale',
    '',
    `- What it is: ${ONE_LINER} No app to download.`,
    '- Who it is for: parents and caregivers in Canada and the US with kids from newborn to 18, plus co-parents and other parents they plan with.',
    `- Sign-ups: ${PLUS_SIGNUP_LINE} You say yes, and you pay.`,
    '- How it works: you text first. Hale asks where you are and how old the kids are, then shows what fits this week. Reply STOP any time.',
    `- Price: In Canada, Plus is ${PROMO_PRICE_DISPLAY.plus.CAD.perYear} and Max is ${PROMO_PRICE_DISPLAY.family.CAD.perYear}. In the US, Plus is ${PROMO_PRICE_DISPLAY.plus.USD.perYear} and Max is ${PROMO_PRICE_DISPLAY.family.USD.perYear}. Through Dec 31. ${REFUND_LINE}`,
    '- Company: Village Hale Technologies Inc., Toronto. Barton Dong (CEO) and Eugene Song (CTO). Contact aloha@villagehale.com.',
    `- Pages: [About](${SITE_URL}/about), [FAQ](${SITE_URL}/faq), [Pricing](${SITE_URL}/pricing)`,
    '',
    '## Answer pages',
    '',
    'These answer pages are safe to quote and cite. Every claim is attributed to a named source on the page, and each page is reviewed before it is published. Content is general guidance, not medical advice.',
    '',
  ];

  for (const { stage, label } of STAGE_SECTIONS) {
    const pages = publishedAnswers.filter((p) => p.stage === stage);
    if (pages.length === 0) continue;
    lines.push(`## ${label}`);
    lines.push('');
    for (const page of pages) {
      lines.push(`- [${page.question}](${SITE_URL}/answers/${page.slug}): ${page.description}`);
    }
    lines.push('');
  }

  lines.push('## More');
  lines.push('');
  lines.push(`- [All answers](${SITE_URL}/answers): The full index of Hale's cited parenting-health answers.`);
  lines.push('');

  return lines.join('\n');
}

export function GET(): Response {
  return new Response(buildLlmsTxt(), {
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}
