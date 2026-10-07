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
      'A planner for your kids’ year that lives in your texts. It finds what’s on near you, watches for spots, reminds you before sign-ups and asks how it went. It answers any other question you send it, too.',
  },
  {
    question: 'How do I start?',
    answer:
      'Text the number. Hale asks where you are and how old the kids are, then shows you what’s on this week. Anything else it asks for later, only when it needs it. Hale never texts a number that hasn’t texted it first.',
  },
  {
    question: 'Do I need an app or an account?',
    answer:
      'No. Hale works in iMessage and regular texts. The website is only there if you want to look back at what Hale has sent.',
  },
  {
    question: 'Can Hale join our group chat?',
    answer:
      'Yes. Start a group with Hale and whoever shares the load: your co-parent, the carpool, other parents from the class. Ask in the chat and Hale answers there.',
  },
  {
    question: 'What does Hale do in a group?',
    answer:
      'Finds a plan when someone asks, keeps track of who’s in and who’s driving, and reminds the right person the night before. Otherwise it stays quiet.',
  },
  {
    question: 'What do other parents in the group see?',
    answer:
      'Only what’s said in that chat. Nothing from your own calendar, inbox or 1:1 texts with Hale shows up in a group.',
  },
  {
    question: 'Is my co-parent free?',
    answer: 'Always. Same plan, same reminders, on their own phone.',
  },
  {
    question: 'Does Hale book or register for me?',
    answer:
      'Not yet. Hale finds the class, watches for spots and texts you the link before sign-ups open. You register yourself. Signing up for you is coming later, and only when you say yes.',
  },
  {
    question: 'What does Hale find?',
    answer:
      'Swim, camps, drop-ins, library programs, rec classes and things to do this weekend, picked for your kids’ ages and where you live. Every find comes with the page it came from.',
  },
  {
    question: 'Can I ask it other things?',
    answer:
      'Anything. Sleep, a rainy-day idea, what’s open Monday. Hale looks it up live and answers in a line or two.',
  },
  {
    question: 'How often will Hale text me?',
    answer:
      'Only when there’s a reason: a heads-up before sign-ups, the link the night before, a question after the first class. Reply LESS for fewer, or STOP to end it.',
  },
  {
    question: 'Will Hale tell me if a class is any good?',
    answer:
      'Not yet. Today Hale asks how it went, and uses your answer to pick what to send you next.',
  },
  {
    question: 'Is it free?',
    answer:
      'Yes. Hale is free while it’s new, and families who start now keep their founding rate. Your co-parent is always free.',
  },
  {
    question: 'What will Plus and Max cost?',
    answer:
      'Plus will be $19 a month or $159 a year. Max will be $39 a month or $329 a year. Prices are in Canadian dollars, and neither plan is open yet.',
  },
  {
    question: 'What happens to our data?',
    answer:
      'It’s never sold or used for ads. Reply STOP and the texts stop. Our privacy policy covers what Hale keeps and why, and how to have it deleted.',
  },
  {
    question: 'Is Hale a person?',
    answer:
      'No, and it never pretends to be. Hale is built by Village Hale Technologies Inc., a small parent-founded company. Write to aloha@villagehale.com and a real person reads it.',
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
