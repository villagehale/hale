import type { Metadata } from 'next';
import { SeaTurtle } from '~/components/illos';
import { SiteFooter } from '~/components/site-footer';
import { SiteHeader } from '~/components/site-header';
import { type HeadlineSegment, WordsPullUp } from '~/components/words-pull-up';
import { buildAlternates } from '~/i18n/metadata';
import type { Locale } from '~/i18n/routing';
import { getTranslator } from '~/i18n/server';

interface PageProps {
  params: Promise<{ locale: Locale }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const t = getTranslator(locale, 'Contact');
  return {
    title: t('metaTitle'),
    description: t('metaDescription'),
    alternates: buildAlternates(locale, '/contact'),
  };
}

// The two inbox addresses are structural, not copy — one general, one for privacy.
const CHANNEL_EMAILS = ['aloha@villagehale.com', 'privacy@villagehale.com'] as const;

export default async function ContactPage({ params }: PageProps) {
  const { locale } = await params;
  const t = getTranslator(locale, 'Contact');
  const channels = t.raw('channels') as { eyebrow: string; line: string }[];

  return (
    <main id="main" tabIndex={-1} className="relative">
      <SiteHeader locale={locale} />

      {/* One centred column, and nothing beside it. A contact page has exactly one
          job, and a two-column hero gives the eye somewhere else to go. */}
      <section className="shell pt-14 sm:pt-20 pb-16 lg:pb-24">
        <div className="mx-auto flex max-w-xl flex-col items-center text-center">
          <SeaTurtle age="adult" style={{ width: 'clamp(96px, 16vw, 132px)', height: 'auto' }} />
          <span className="eyebrow mt-8">{t('eyebrow')}</span>
          <WordsPullUp className="mt-3" segments={t.raw('headline') as HeadlineSegment[]} />
          <p className="mt-6 text-lg" style={{ color: 'var(--color-slate-green)', lineHeight: 1.6 }}>
            {t('lede')}
          </p>
          <a href="mailto:aloha@villagehale.com" className="btn-primary mt-8">
            {t('emailButton')}
          </a>
        </div>
      </section>

      <div className="band-cream grain">
        <section className="shell py-16 lg:py-24">
          <div className="mx-auto grid max-w-3xl grid-cols-1 gap-6 md:grid-cols-2 lg:gap-8">
            {channels.map((channel, i) => {
              const email = CHANNEL_EMAILS[i] ?? CHANNEL_EMAILS[0];
              return (
                <div key={email} className="glass-panel flex flex-col gap-4 p-6 sm:p-7">
                  <span className="eyebrow">{channel.eyebrow}</span>
                  <p style={{ color: 'var(--color-slate-green)', lineHeight: 1.55 }}>{channel.line}</p>
                  <a href={`mailto:${email}`} className="link mt-auto self-start">
                    {email}
                  </a>
                </div>
              );
            })}
          </div>
          <p className="meta mx-auto mt-8 max-w-3xl text-slate-green">{t('note')}</p>
        </section>
      </div>

      <SiteFooter locale={locale} />
    </main>
  );
}
