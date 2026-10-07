import { SiteFooter } from '~/components/site-footer';
import { SiteHeader } from '~/components/site-header';
import { Wordmark } from '~/components/wordmark';
import type { Locale } from '~/i18n/routing';
import { faqJsonLd } from '~/lib/faq';
import { DesignCta } from './shared';

export const DESIGN_FAQ_GROUPS = [
  {
    id: 'start',
    label: 'Getting started',
    items: [
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
    ],
  },
  {
    id: 'groups',
    label: 'Group chats',
    items: [
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
    ],
  },
  {
    id: 'does',
    label: 'What Hale does',
    items: [
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
    ],
  },
  {
    id: 'cost',
    label: 'Cost',
    items: [
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
    ],
  },
  {
    id: 'privacy',
    label: 'Privacy and safety',
    items: [
      {
        question: 'Where is our data kept?',
        answer:
          'In Canada, under PIPEDA and Quebec’s Law 25. It’s never sold. Reply STOP and the texts stop.',
      },
      {
        question: 'Is Hale a person?',
        answer:
          'No, and it never pretends to be. Hale is built by Village Hale Technologies Inc., a small parent-founded company in Georgetown, Ontario. Write to aloha@villagehale.com and a real person reads it.',
      },
      {
        question: 'Does Hale work outside Canada?',
        answer: 'Not yet. Hale is Canada-first, so your family’s data stays in Canada.',
      },
    ],
  },
];

/** October 2026 design handoff; source copy is a local review draft. */
export function DesignFaq({ locale }: { locale: Locale }) {
  return (
    <main id="main" tabIndex={-1} className="design-marketing">
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: serialized supplied FAQ copy, not user input.
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(
            faqJsonLd(
              DESIGN_FAQ_GROUPS.flatMap((group) => group.items),
              locale,
            ),
          ),
        }}
      />
      <div className="stage sp-stage">
        <img
          className="shore-art"
          src="/landing-oct-2026/hale-shore-hero.webp"
          alt=""
          aria-hidden="true"
        />
        <span className="shore-drift sky" aria-hidden="true" />
        <span className="shore-drift sea" aria-hidden="true" />
        <span className="shore-scrim" aria-hidden="true" />
        <SiteHeader locale={locale} redesign />
        <section className="sp-hero">
          <div className="sp-grid">
            <div className="sp-copy">
              <p className="hs-eyebrow">{'Questions'}</p>
              <h1 className="sp-h1">{'Is Hale right for your family?'}</h1>
              <p className="sp-lede">
                {
                  'Straight answers about what Hale does, what it costs and how your family’s data is handled.'
                }
              </p>
            </div>
          </div>
        </section>
      </div>
      <div className="hs-page">
        <section className="hs hs-wash-a">
          <div className="hs-wrap hs-grid">
            <div className="hs-faq-l">
              <p className="hs-eyebrow">{'Jump to'}</p>
              <ul className="sp-toc">
                <li>
                  <a href="#start">{'Getting started'}</a>
                </li>
                <li>
                  <a href="#groups">{'Group chats'}</a>
                </li>
                <li>
                  <a href="#does">{'What Hale does'}</a>
                </li>
                <li>
                  <a href="#cost">{'Cost'}</a>
                </li>
                <li>
                  <a href="#privacy">{'Privacy and safety'}</a>
                </li>
              </ul>
            </div>
            <div className="hs-faq-r">
              {DESIGN_FAQ_GROUPS.map((group) => (
                <div className="sp-faq-group" id={group.id} key={group.id}>
                  <span className="sp-tag">{group.label}</span>
                  {group.items.map((item) => (
                    <div className="hs-qa" key={item.question}>
                      <h3 className="hs-h3">{item.question}</h3>
                      <p className="hs-p">{item.answer}</p>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </section>
        <section className="hs hs-close-sec" id="start">
          <div className="hs-wrap">
            <div className="hs-close-card">
              <img
                className="hs-close-art"
                src="/landing-oct-2026/hale-shore-hero.webp"
                alt=""
                aria-hidden="true"
              />
              <span className="hs-close-scrim" aria-hidden="true" />
              <div className="hs-close-body">
                <span className="hs-close-brand">
                  <img src="/landing-oct-2026/hale-logo.jpeg" alt="" />
                  <Wordmark className="wordmark" />
                </span>
                <h2>{'Still wondering? Just ask.'}</h2>
                <p className="hs-close-sub">
                  {'Text Hale your question. It answers in a line or two, the same minute.'}
                </p>
                <div className="hs-close-cta">
                  <DesignCta locale={locale} className="btn btn-hero">
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 16 16"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M8 2.5c3.3 0 6 2.2 6 4.9s-2.7 4.9-6 4.9c-.7 0-1.3-.1-1.9-.2L3 13.5l.9-2.5C2.7 10.1 2 8.8 2 7.4 2 4.7 4.7 2.5 8 2.5z" />
                    </svg>
                    {'Text Hale'}
                  </DesignCta>
                </div>
                <p className="hs-close-terms">
                  {
                    'Free to start. You text first; standard message rates apply, reply STOP any time.'
                  }
                </p>
              </div>
            </div>
          </div>
        </section>
        <SiteFooter locale={locale} redesign />
      </div>
    </main>
  );
}
