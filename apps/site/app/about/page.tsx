import { ArrowUpRight, Check } from 'lucide-react';
import type { Metadata } from 'next';
import { CharReveal } from '~/components/char-reveal';
import { CtaBand } from '~/components/cta-band';
import { Village } from '~/components/illos';
import { SiteFooter } from '~/components/site-footer';
import { SiteHeader } from '~/components/site-header';
import { WordsPullUp } from '~/components/words-pull-up';
import { chromeCta } from '~/lib/site/chrome-cta';

export const metadata: Metadata = {
  title: 'About · Hale',
  description:
    'Hale is a number your family texts — a quiet chief of staff for the dates, the forms, and the small things that slip. Built by Anzhe Dong at Village Hale Technologies Inc. in Georgetown, Ontario.',
};

const SOCIALS = [
  { label: 'LinkedIn', href: 'https://www.linkedin.com/in/anzhe-dong/' },
  { label: 'X', href: 'https://x.com/therealbossdong' },
  { label: 'GitHub', href: 'https://github.com/donganzh' },
] as const;

/**
 * The ladder — recommend, prepare, execute-with-consent — which is the product
 * doctrine (F14 · D-register) and the same three rungs the homepage states in
 * Hale's own voice. Numbered because it genuinely is a sequence: each rung is
 * only reached once the one below it has earned it. Every checklist line below
 * restates a claim the homepage already makes; nothing here is new ground.
 */
const LADDER = [
  {
    tag: 'Recommend',
    title: 'Hale suggests',
    line: 'The thing worth knowing this week, and why it matters now.',
    checks: [
      'A brief on Monday morning',
      'A heads-up the week a registration opens',
      'Quiet in between',
    ],
    link: { label: 'Parenting guides', href: '/answers' },
  },
  {
    tag: 'Prepare',
    title: 'Hale gets it ready',
    line: 'The shortlist, the links, the times — before the window opens, not after.',
    checks: ['The plan the evening before', 'A nudge as it goes live', 'The links and the times'],
    link: { label: 'What it costs', href: '/pricing' },
  },
  {
    tag: 'Execute',
    title: 'With your ok, Hale handles it',
    line: 'Nothing reaches the outside world until you say so.',
    checks: [
      'A calendar invite for a date you say yes to',
      'Every message names exactly what was done',
      'Consent you grant in a text and withdraw in a text',
    ],
    link: { label: 'How your data is handled', href: '/privacy' },
  },
] as const;

/** One paragraph, read at the speed of the scroll. See components/char-reveal.tsx. */
const FOUNDER_STORY =
  'Hale is built by Anzhe Dong — a father, husband, and founder who spent years shipping production agentic systems. He started it raising a kid far from the village his own parents had: no elders down the street, no one who just knew which class was worth it. The trust was still out there, in what other parents told each other; it just couldn’t reach him. So he built the thing he kept wishing someone would text him.';

export default function AboutPage() {
  // The one front door the site chrome offers. This page used to close on the
  // app's /onboarding wizard, which F14 deleted — the only action on /about was
  // a 308 back to the homepage.
  const cta = chromeCta();

  return (
    <main id="main" tabIndex={-1} className="relative">
      <SiteHeader />

      <section className="shell pt-10 sm:pt-16 pb-16 lg:pb-24">
        <div className="max-w-2xl">
          <span className="eyebrow">About Hale</span>
          <WordsPullUp
            className="mt-3"
            segments={[
              { text: 'Why Hale is' },
              { text: 'a number,', accent: true },
              { text: 'not another app.' },
            ]}
          />
          <p
            className="reading-measure mt-6 text-lg"
            style={{ color: 'var(--color-slate-green)', lineHeight: 1.6 }}
          >
            Once, a family had a village — elders who knew which class was worth it, neighbors who
            carried the small things, a grandmother who said this is normal, you are doing fine.
            That knowing hasn’t disappeared. It just has nowhere to live now except one parent’s
            memory — and no app fixes a memory problem by asking for more of your attention. So Hale
            is a number you text.
          </p>
        </div>
      </section>

      <section className="shell pb-16 lg:pb-24">
        <div className="band-cream grain rounded-[24px] px-8 py-14 sm:px-14 sm:py-20 lg:px-20">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-10 lg:gap-x-16 items-center">
            <div className="lg:col-span-8">
              <span className="eyebrow">Our mission</span>
              <p
                className="mt-5 font-display max-w-3xl"
                style={{
                  fontSize: 'clamp(1.4rem, 2.6vw, 2rem)',
                  lineHeight: 1.32,
                  letterSpacing: 'var(--tracking-display)',
                  fontWeight: 600,
                }}
              >
                Every parent deserves a chief of staff — someone who holds the dates, the forms, and
                the small things that slip, and hands back the evening. Across every stage of
                childhood, from the first months to almost grown.
              </p>
            </div>
            <div className="lg:col-span-4 flex justify-center lg:justify-end">
              <Village style={{ width: 'clamp(180px, 30vw, 240px)', height: 'auto' }} />
            </div>
          </div>
        </div>
      </section>

      <section className="shell pb-16 lg:pb-24">
        <div className="max-w-2xl">
          <span className="eyebrow">How Hale works</span>
          <WordsPullUp
            as="h2"
            className="mt-3"
            segments={[{ text: 'It earns' }, { text: 'each rung.', accent: true }]}
          />
          <p className="meta mt-5 text-lg" style={{ lineHeight: 1.6 }}>
            Hale starts by telling you things and only ever does things with your say-so. The ladder
            is the whole product: it climbs one rung at a time, and only when you let it.
          </p>
        </div>

        <ol className="mt-10 grid grid-cols-1 gap-6 lg:grid-cols-3 lg:gap-8">
          {LADDER.map((rung, i) => (
            <li key={rung.tag} className="glass-panel numbered-card">
              <div className="numbered-card-head">
                <span className="eyebrow">{rung.tag}</span>
                <span className="numbered-card-num">0{i + 1}</span>
              </div>
              <h3 className="mt-5 text-[1.15rem] leading-snug">{rung.title}</h3>
              <p className="mt-3" style={{ color: 'var(--color-slate-green)', lineHeight: 1.6 }}>
                {rung.line}
              </p>
              <ul className="numbered-card-list">
                {rung.checks.map((check) => (
                  <li key={check}>
                    <Check size={16} strokeWidth={2.5} aria-hidden="true" />
                    <span>{check}</span>
                  </li>
                ))}
              </ul>
              {/* `mt-auto` drops the three links onto one line across the grid. */}
              <a href={rung.link.href} className="quiet-link mt-auto pt-7">
                {rung.link.label}
                <ArrowUpRight size={14} strokeWidth={2.25} aria-hidden="true" />
              </a>
            </li>
          ))}
        </ol>
      </section>

      <section className="shell pb-16 lg:pb-24">
        <div className="max-w-2xl">
          <span className="eyebrow">The founder</span>
          <WordsPullUp
            as="h2"
            className="mt-3"
            segments={[{ text: 'Built by a parent, far from' }, { text: 'his village.', accent: true }]}
          />
          <CharReveal className="reading-measure mt-5 text-lg" text={FOUNDER_STORY} />
          <ul className="mt-7 flex flex-wrap gap-x-6 gap-y-3">
            {SOCIALS.map((social) => (
              <li key={social.href}>
                <a
                  href={social.href}
                  target="_blank"
                  rel="me noreferrer"
                  className="link inline-flex items-center gap-1.5"
                >
                  {social.label}
                  <ArrowUpRight size={14} strokeWidth={2.25} aria-hidden="true" />
                </a>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <CtaBand>
        <p
          className="mx-auto max-w-2xl font-display"
          style={{
            fontSize: 'clamp(1.4rem, 2.6vw, 2rem)',
            lineHeight: 1.3,
            letterSpacing: 'var(--tracking-display)',
            fontWeight: 600,
          }}
        >
          It starts with one text — no app, no account, no form to fill in.
        </p>
        <div className="mt-8 flex justify-center">
          <a href={cta.href} className="btn-on-navy">
            {cta.label}
          </a>
        </div>
      </CtaBand>

      <SiteFooter />
    </main>
  );
}
