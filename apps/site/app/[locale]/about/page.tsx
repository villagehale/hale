import { ArrowUpRight, Check } from 'lucide-react';
import type { Metadata } from 'next';
import { CharReveal } from '~/components/char-reveal';
import { CtaBand } from '~/components/cta-band';
import { Village } from '~/components/illos';
import { SiteFooter } from '~/components/site-footer';
import { SiteHeader } from '~/components/site-header';
import { type HeadlineSegment, WordsPullUp } from '~/components/words-pull-up';
import { buildAlternates } from '~/i18n/metadata';
import { localeHref } from '~/i18n/navigation';
import type { Locale } from '~/i18n/routing';
import { getTranslator } from '~/i18n/server';
import { chromeCta } from '~/lib/site/chrome-cta';

interface PageProps {
  params: Promise<{ locale: Locale }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const t = getTranslator(locale, 'About');
  return {
    title: t('metaTitle'),
    description: t('metaDescription'),
    alternates: buildAlternates(locale, '/about'),
  };
}

const SOCIALS = [
  { label: 'LinkedIn', href: 'https://www.linkedin.com/in/anzhe-dong/' },
  { label: 'X', href: 'https://x.com/therealbossdong' },
  { label: 'GitHub', href: 'https://github.com/donganzh' },
] as const;

/**
 * The ladder — recommend, prepare, execute-with-consent — which is the product
 * doctrine (F14 · D-register) and the same three rungs the homepage states in
 * Hale's own voice. The rung copy is localized; the destinations are structural.
 */
const LADDER_HREFS = ['/answers', '/pricing', '/privacy'] as const;

interface Rung {
  tag: string;
  title: string;
  line: string;
  checks: string[];
  linkLabel: string;
}

export default async function AboutPage({ params }: PageProps) {
  const { locale } = await params;
  const t = getTranslator(locale, 'About');
  const ladder = t.raw('ladder') as Rung[];
  // The one front door the site chrome offers. This page used to close on the
  // app's /onboarding wizard, which F14 deleted — the only action on /about was
  // a 308 back to the homepage.
  const cta = chromeCta(locale);

  return (
    <main id="main" tabIndex={-1} className="relative">
      <SiteHeader locale={locale} />

      <section className="shell pt-10 sm:pt-16 pb-16 lg:pb-24">
        <div className="max-w-2xl">
          <span className="eyebrow">{t('eyebrow')}</span>
          <WordsPullUp className="mt-3" segments={t.raw('headline') as HeadlineSegment[]} />
          <p
            className="reading-measure mt-6 text-lg"
            style={{ color: 'var(--color-slate-green)', lineHeight: 1.6 }}
          >
            {t('lede')}
          </p>
        </div>
      </section>

      <section className="shell pb-16 lg:pb-24">
        <div className="band-cream grain rounded-[24px] px-8 py-14 sm:px-14 sm:py-20 lg:px-20">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-10 lg:gap-x-16 items-center">
            <div className="lg:col-span-8">
              <span className="eyebrow">{t('missionEyebrow')}</span>
              <p
                className="mt-5 font-display max-w-3xl"
                style={{
                  fontSize: 'clamp(1.4rem, 2.6vw, 2rem)',
                  lineHeight: 1.32,
                  letterSpacing: 'var(--tracking-display)',
                  fontWeight: 600,
                }}
              >
                {t('mission')}
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
          <span className="eyebrow">{t('howEyebrow')}</span>
          <WordsPullUp as="h2" className="mt-3" segments={t.raw('howHeadline') as HeadlineSegment[]} />
          <p className="meta mt-5 text-lg" style={{ lineHeight: 1.6 }}>
            {t('howLede')}
          </p>
        </div>

        <ol className="mt-10 grid grid-cols-1 gap-6 lg:grid-cols-3 lg:gap-8">
          {ladder.map((rung, i) => (
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
              <a href={localeHref(locale, LADDER_HREFS[i] ?? '/')} className="quiet-link mt-auto pt-7">
                {rung.linkLabel}
                <ArrowUpRight size={14} strokeWidth={2.25} aria-hidden="true" />
              </a>
            </li>
          ))}
        </ol>
      </section>

      <section className="shell pb-16 lg:pb-24">
        <div className="max-w-2xl">
          <span className="eyebrow">{t('founderEyebrow')}</span>
          <WordsPullUp
            as="h2"
            className="mt-3"
            segments={t.raw('founderHeadline') as HeadlineSegment[]}
          />
          <CharReveal className="reading-measure mt-5 text-lg" text={t('founderStory')} />
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
          {t('cta')}
        </p>
        <div className="mt-8 flex justify-center">
          <a href={cta.href} className="btn-on-navy">
            {cta.label}
          </a>
        </div>
      </CtaBand>

      <SiteFooter locale={locale} />
    </main>
  );
}
