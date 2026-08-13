import { SITE_URL } from '~/lib/app-url';
import { f14LandingEnabled } from '~/lib/flags/landing';

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
 * The same questions, answered for the product Hale actually became (D20/D21).
 *
 * The list above describes an app a parent signs up for and browses; under the F14
 * landing there is no signup and no browsing, so leaving it in place would have the
 * canonical FAQ — and the FAQPage schema an answer engine reads from it — describing
 * a product the homepage no longer offers. Every claim here is checkable against
 * shipped code: the seeded registration windows, the loop_prefs send defaults, the
 * registration sequence's legs, the coach-plan skill, and provision.ts's account shape.
 */
const F14_FAQ: readonly FaqItem[] = [
  {
    question: 'What is Hale?',
    answer:
      'A phone number your family texts. Hale is a chief of staff for the household — it watches the registration dates and programs where you live, plans the week, answers the parenting questions, and does the admin once you say yes. There is no app to install and no account to create.',
  },
  {
    question: 'How do I start?',
    answer:
      'You text the number and say hi. Hale asks for your kids’ names and ages and your postal code, and that is the whole setup — everything else it asks for later, only when it needs it. Hale never texts you first; the conversation is always one you started.',
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
 * The FAQ this build serves, following the landing flag exactly like the homepage,
 * its metadata, its share card and its JSON-LD do. Read in a Server Component and
 * passed down — never called from a 'use client' module.
 */
export function productFaq(): readonly FaqItem[] {
  return f14LandingEnabled() ? F14_FAQ : FAQ;
}

/**
 * The FAQPage JSON-LD for /faq. Each item becomes a Question with an acceptedAnswer,
 * tied to the site’s Organization/WebSite graph by isPartOf. Pure + exported so the
 * shape is unit-tested against the served list rather than eyeballed.
 */
export function faqJsonLd(): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    '@id': `${SITE_URL}/faq#faq`,
    inLanguage: 'en-CA',
    isPartOf: { '@id': `${SITE_URL}/#website` },
    publisher: { '@id': `${SITE_URL}/#organization` },
    mainEntity: productFaq().map((item) => ({
      '@type': 'Question',
      name: item.question,
      acceptedAnswer: { '@type': 'Answer', text: item.answer },
    })),
  };
}
