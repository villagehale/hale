import { publishedAnswers } from '~/lib/answers/index';
import { SITE_URL } from '~/lib/app-url';
import type { FamilyStage } from '@hale/types';

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
    '> Hale is a planner for your kids\' year, for every stage of childhood (0–18). Find what\'s on. Hear how it went. Its answer pages give calm, plain answers to the parenting-health questions families search for — each one grounded in trusted, cited frameworks (Canadian Paediatric Society, Health Canada, American Academy of Pediatrics, and named parenting authors) and honest that it is general guidance, never a substitute for a family\'s own health provider.',
    '',
    '## About Hale',
    '',
    '- What it is: an iMessage and text (SMS) helper that plans kids\' activities and the family year. No app to download.',
    '- Who it is for: parents and caregivers in the US and Canada with kids from newborn to 18, plus co-parents and other parents they plan with.',
    '- What it does: finds activities near you by age (swim, camps, drop-ins, library programs, rec classes) with the source page for each; watches full classes for spots; reminds you before registration; asks how it went; works in group chats; reads photos of flyers and schedules; replies in the language you write in; with permission, reads Gmail and Google Calendar to keep dates straight, asking before it adds or changes anything.',
    '- What it does not do: it does not book, register or pay for you.',
    '- How it works: text Hale, tell it where you are and your kids\' ages, and it shows what\'s on this week. It texts only when there is a reason. Reply STOP any time.',
    '- Price: free with unlimited chat. Paid plans: Plus $19 CAD/mo · $15 USD/month or $159/year; Max $39 CAD/mo · $29 USD/month or $329/year. Families who join now get every feature free until paid plans start.',
    '- Company: Village Hale Technologies Inc., Georgetown, Ontario. Founders Barton Dong (CEO) and Eugene Song (CTO). Contact aloha@villagehale.com.',
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
