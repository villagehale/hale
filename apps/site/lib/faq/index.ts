import { SITE_URL } from '~/lib/app-url';

/**
 * The product FAQ — the questions a parent actually asks an answer engine before
 * trusting a new app with their child's data ("is it free?", "is it private?",
 * "how is it different from a tracker?"). Distinct from the /answers section, which
 * is parenting-health content; this is about Hale itself. Every answer is a plain,
 * verifiable claim grounded in the product's real posture (free-first launch,
 * Canada-only data residency, teen redaction, observe-only default) — no marketing
 * that outruns what the product does. Pure data so the FAQPage schema is derived,
 * not hand-maintained twice.
 */
export interface FaqItem {
  question: string;
  answer: string;
}

export const FAQ: readonly FaqItem[] = [
  {
    question: 'Is Hale free?',
    answer:
      'Yes — Hale is free to start, and the core is free: trusted local activities near you, gentle tracking, and your family’s own view of what matters. Paid plans are a later add-on for deeper automation, not a gate on the everyday value.',
  },
  {
    question: 'Is my family’s data private and secure?',
    answer:
      'Yes. Hale is built privacy-first for the most sensitive data there is — a newborn’s. Your data is stored in Canada and never leaves it, in line with PIPEDA and Quebec’s Law 25. Hale never sells your data.',
  },
  {
    question: 'How is Hale different from a baby-tracking app?',
    answer:
      'A tracker asks you to log everything. Hale is passive — it works quietly in the background, and instead of another chart it brings back the “village”: the classes, groups, and drop-ins near you that other families actually value.',
  },
  {
    question: 'What ages is Hale for?',
    answer:
      'Every stage of childhood, from newborn to 18 — newborn, toddler, child, and teen — adapting what it surfaces and how it protects privacy as your child grows.',
  },
  {
    question: 'How does Hale protect my teenager’s privacy?',
    answer:
      'Teens 13 and older get real privacy by default: their content is summarized for a parent, not shown raw, unless the teen agrees. The one exception is a genuine safety concern — and there, the teen is notified.',
  },
  {
    question: 'Does Hale act on its own?',
    answer:
      'Only with your explicit consent. New accounts start in an observe-only mode, and nothing happens on your behalf until you approve that specific kind of action. You are always in control.',
  },
  {
    question: 'Do I have to enter a lot of information?',
    answer:
      'No. Hale is event-driven and passive by design — it is not another daily logging chore. You share what you want, when you want, and it does the quiet work of noticing what’s useful.',
  },
  {
    question: 'Is Hale available outside Canada?',
    answer:
      'Hale is Canada-first today, because keeping your family’s data on Canadian soil is a core promise, not a setting. Support for other regions is on the roadmap.',
  },
] as const;

/**
 * The FAQPage JSON-LD for /faq. Each item becomes a Question with an acceptedAnswer,
 * tied to the site’s Organization/WebSite graph by isPartOf. Pure + exported so the
 * shape is unit-tested against FAQ rather than eyeballed.
 */
export function faqJsonLd(): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    '@id': `${SITE_URL}/faq#faq`,
    inLanguage: 'en-CA',
    isPartOf: { '@id': `${SITE_URL}/#website` },
    publisher: { '@id': `${SITE_URL}/#organization` },
    mainEntity: FAQ.map((item) => ({
      '@type': 'Question',
      name: item.question,
      acceptedAnswer: { '@type': 'Answer', text: item.answer },
    })),
  };
}
