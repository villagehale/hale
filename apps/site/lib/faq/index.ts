import { languageTag } from '~/i18n/metadata';
import { type Locale, routing } from '~/i18n/routing';
import { SITE_URL } from '~/lib/app-url';
import { MUNICIPALITY_COUNT } from '~/lib/site/municipalities';

/**
 * The product FAQ — the questions a parent actually asks an answer engine before
 * trusting a new number with their family ("what is it?", "is it free?", "is it
 * private?"). Distinct from the /answers section, which is parenting-health content;
 * this is about Hale itself. Every claim is checkable against shipped code: the
 * seeded registration windows, the loop_prefs send defaults, the registration
 * sequence's legs, the coach-plan skill, and provision.ts's account shape — no
 * marketing that outruns what the product does. Pure data so the FAQPage schema is
 * derived, not hand-maintained twice.
 *
 * Order is risk → time → money: what Hale is, how to start, then the two questions
 * a parent handing over children's data is actually weighing (does it act on its
 * own, where does the data live) before mechanics and cost. The accordion opens
 * item one, so what sits in the top four is what a skimming reader sees at all.
 */
export interface FaqItem {
  question: string;
  answer: string;
}

export const FAQ: readonly FaqItem[] = [
  {
    question: 'What is Hale?',
    answer:
      'A planner for your kids’ year, on iMessage. You ask with an age, a place, and the kind of spot — toddler swim near Georgetown on Saturday is the kind of thing you can ask, not a promise of what comes back. Hale looks it up, watches recreation, TEE, and swim drops, and texts when a place opens. There is no app to install and no account to create. Hale does not book a class or register you.',
  },
  {
    question: 'How do I start?',
    answer:
      'You text the number and ask. An age, a place, and the spot is enough to start. The first session is the find; the time and the link come after you pick. Hale never texts a number that hasn’t texted it first.',
  },
  {
    question: 'Does Hale do anything without asking?',
    answer:
      'No. Hale finds what’s on and asks one question after you pick — it does not book a class or register you. Every message names what it found, and Hale keeps the full record of who asked, what was sent and when.',
  },
  {
    question: 'Is my family’s data private?',
    answer:
      'Your data is stored in Canada and never leaves it, in line with PIPEDA and Quebec’s Law 25, and Hale never sells it. Every permission is granular and revocable in a text. iMessage through Linq is not sealed the way an app is — a message crosses your carrier and Linq — so Hale writes to that reality and names the activity and the time, never a diagnosis. A teenager’s content is redacted from parents by default.',
  },
  {
    question: 'Is this a bot? Who actually reads my texts?',
    answer:
      'Hale is a planner for your kids’ year, and it never pretends to be a person. It is built and run by Village Hale Technologies Inc., a small parent-founded company in Georgetown, Ontario — and a real person reads anything you send to aloha@villagehale.com. Hale never texts a number that hasn’t texted it first, and never asks you to text back a password, a card number or a code.',
  },
  {
    question: 'What does Hale actually watch?',
    answer: `A live find by age, place, and the kind of spot you asked for, plus recreation, TEE, and swim drops across ${MUNICIPALITY_COUNT} GTA municipalities. When a class you wanted is already full, Hale keeps watching it and texts you when a place opens. If you connect Gmail or Google Calendar, Hale reads new mail and events and texts one short line — the activity and the time. It does not push changes back to Google.`,
  },
  {
    question: 'How often will Hale text me?',
    answer:
      'When you ask, with what it found. When a watched class has a place open. One short line from a connected inbox or calendar — the activity and the time. And one question partway through something you picked, so the answer can shape the next find.',
  },
  {
    question: 'Can Hale answer parenting questions, or only scheduling ones?',
    answer:
      'You can ask what’s on, and you can ask a parenting question in the same thread. Hale never diagnoses and never names a dose. For anything about your child’s health, talk to your provider.',
  },
  {
    question: 'Is Hale free?',
    answer:
      'Yes. Hale is free, with unlimited chat. There is no paid plan. A second parent in the family group is a co-parent, on their own number, in the same free chat.',
  },
  {
    question: 'Do I need to use the website?',
    answer:
      'No. The finding and the questions happen in the iMessage thread. The full record of what Hale has sent is yours whenever you want it — ask for it in the thread, or sign in with your phone number and read it there.',
  },
  {
    question: 'Will you tell me whether a class is any good?',
    answer:
      'Not yet. Today Hale asks one question partway through something you picked. Telling the next parent what other families thought is not live, and if it ever is it will be a count and a verdict — never anyone’s words.',
  },
  {
    question: 'Can you help when we travel?',
    answer: 'Not yet. Today Hale looks things up where you ask, and watches recreation drops in the GTA.',
  },
  {
    question: 'Can you tell me who else is going?',
    answer:
      'Only with a yes from both families. Hale introduces two families on the same activity only when each has said yes. It does not share one family’s words with another.',
  },
  {
    question: 'Is Hale available outside Canada?',
    answer:
      'Not yet. Hale is Canada-first because keeping your family’s data on Canadian soil is a core promise rather than a setting, and the recreation data it watches is GTA municipal data. Other regions are on the roadmap.',
  },
] as const;

/**
 * The FAQPage JSON-LD for /faq. Each item becomes a Question with an acceptedAnswer,
 * tied to the site’s Organization/WebSite graph by isPartOf. Pure + exported so the
 * shape is unit-tested against the served list rather than eyeballed. Defaults to the
 * English list; the localized route passes its translated items and locale so the
 * schema matches the page a reader (or answer engine) actually sees.
 */
export function faqJsonLd(
  items: readonly FaqItem[] = FAQ,
  locale: Locale = routing.defaultLocale,
): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    '@id': `${SITE_URL}/faq#faq`,
    inLanguage: languageTag(locale),
    isPartOf: { '@id': `${SITE_URL}/#website` },
    publisher: { '@id': `${SITE_URL}/#organization` },
    mainEntity: items.map((item) => ({
      '@type': 'Question',
      name: item.question,
      acceptedAnswer: { '@type': 'Answer', text: item.answer },
    })),
  };
}
