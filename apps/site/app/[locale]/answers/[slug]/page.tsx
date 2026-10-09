import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { RedesignGuide } from '~/components/redesign/guide';
import { buildAlternates, ogLocale } from '~/i18n/metadata';
import { localeHref } from '~/i18n/navigation';
import type { Locale } from '~/i18n/routing';
import { allAnswers, getAnswer } from '~/lib/answers/index';
import { answerJsonLd } from '~/lib/answers/structured-data';
import { intakePrefill } from '~/lib/intake-prefill';
import { readSmsNumber } from '~/lib/text-entry';

interface PageProps {
  params: Promise<{ locale: Locale; slug: string }>;
}

export function generateStaticParams(): { slug: string }[] {
  return allAnswers.map((a) => ({ slug: a.slug }));
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale, slug } = await params;
  const page = getAnswer(slug);
  if (!page) return {};

  const canonical = `/answers/${page.slug}`;
  const title = `${page.title} · Hale`;
  return {
    title,
    description: page.description,
    alternates: buildAlternates(locale, canonical),
    // Review-before-index gate: a draft stays out of the index until a human
    // flips `published`. Published pages get the default (indexable) directive.
    robots: page.published ? undefined : { index: false, follow: true },
    openGraph: {
      type: 'article',
      title,
      description: page.description,
      url: localeHref(locale, canonical),
      siteName: 'Hale',
      locale: ogLocale(locale),
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description: page.description,
    },
  };
}

export default async function AnswerRoute({ params }: PageProps) {
  const { locale, slug } = await params;
  const page = getAnswer(slug);
  if (!page) notFound();

  return (
    <>
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: JSON-LD is a serialized in-repo data object (no user input) — the standard way to emit SEO structured data.
        dangerouslySetInnerHTML={{ __html: JSON.stringify(answerJsonLd(page)) }}
      />
      <RedesignGuide
        locale={locale}
        page={page}
        smsNumber={readSmsNumber(process.env.NEXT_PUBLIC_HALE_SMS_NUMBER)}
        prefill={intakePrefill(locale)}
      />
    </>
  );
}
