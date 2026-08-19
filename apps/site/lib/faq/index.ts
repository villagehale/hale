import { languageTag } from '~/i18n/metadata';
import { type Locale, routing } from '~/i18n/routing';
import { SITE_URL } from '~/lib/app-url';

/**
 * The product FAQ — the questions a parent actually asks an answer engine before
 * trusting a new number with their family ("what is it?", "is it free?", "is it
 * private?"). Distinct from the /answers section, which is parenting-health content;
 * this is about Hale itself. Every claim is checkable against shipped code: the
 * seeded registration windows, the loop_prefs send defaults, the registration
 * sequence's legs, the coach-plan skill, and provision.ts's account shape — no
 * marketing that outruns what the product does. Pure data so the FAQPage schema is
 * derived, not hand-maintained twice.
 */
export interface FaqItem {
  question: string;
  answer: string;
}

export const FAQ: readonly FaqItem[] = [
  {
    question: 'What is Hale?',
    answer:
      'A phone number your family texts. Hale watches the registration dates and programs where you live, plans the week, answers the parenting questions, and does the admin once you say yes — all in one text thread. There is no app to install and no account to create.',
  },
  {
    question: 'How do I start?',
    answer:
      'You text the number and say hi. Hale asks for your kids’ names and ages and your postal code, and that is the whole setup — everything else it asks for later, only when it needs it. Hale never texts you first; the conversation is always one you started.',
  },
  {
    question: 'Is this a bot? Who actually reads my texts?',
    answer:
      'Hale is an AI assistant, and it never pretends otherwise. It is built and run by Village Hale Technologies Inc., a small parent-founded company in Georgetown, Ontario — and a real person reads anything you send to aloha@villagehale.com. Hale never texts you first, never asks you to text back a password, a card number or a code, and STOP ends the conversation at any time.',
  },
  {
    question: 'What does Hale actually watch?',
    answer:
      'Municipal registration across fifteen GTA municipalities — recreation programs, swim lessons, camps and after-school care — including the resident head start, the towns that register swimming on their own date, and the winter-break camps that open back in August. It also watches the waitlist clock, which is a day in some towns and two in others.',
  },
  {
    question: 'How often will Hale text me?',
    answer:
      'A brief on Monday morning, and then only when something needs you: a heads-up the week a registration opens, the plan the evening before, and a nudge as it goes live. It is quiet in between, and STOP works at any time.',
  },
  {
    question: 'Does Hale do anything without asking?',
    answer:
      'No. Hale drafts and you confirm — nothing reaches the outside world until you reply yes to that specific thing. Every message names exactly what was done, and Hale keeps the full record of who, what and when.',
  },
  {
    question: 'Can Hale answer parenting questions, or only scheduling ones?',
    answer:
      'Both. Ask about sleep, starting solids, potty training, picky eating, tantrums, screen time or routines and you get an answer pitched at your child’s age, plus the offer of the whole plan — two or three texts you can start tonight. Three days later Hale asks how it went. It never diagnoses and never names a dose.',
  },
  {
    question: 'Is Hale free?',
    answer:
      'Hale is free while it is new, and families who start now keep their founding rate. A co-parent is always free — the same radar and reminders on their own number, never a second household to pay for.',
  },
  {
    question: 'Is my family’s data private?',
    answer:
      'Your data is stored in Canada and never leaves it, in line with PIPEDA and Quebec’s Law 25, and Hale never sells it. Every permission is granular and revocable in a text. Text messaging itself is not sealed the way an app is — a message crosses your carrier and Hale’s messaging provider — so Hale writes to that reality and names the task, never the diagnosis. A teenager’s content is redacted from parents by default.',
  },
  {
    question: 'Do I need to use the website?',
    answer:
      'No. Everything happens in the text thread, and Hale will never send you to a website to finish a job you texted it to do. The full record of what Hale has done is yours whenever you want it — ask for it in the thread, or sign in with your phone number and read it there.',
  },
  {
    question: 'Is Hale available outside Canada?',
    answer:
      'Not yet. Hale is Canada-first because keeping your family’s data on Canadian soil is a core promise rather than a setting, and the registration data it watches is GTA municipal data. Other regions are on the roadmap.',
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
