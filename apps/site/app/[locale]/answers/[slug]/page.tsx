import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { RedesignGuide } from '~/components/redesign/guide';
import { absolutePageUrl, buildAlternates, ogLocale } from '~/i18n/metadata';
import type { Locale } from '~/i18n/routing';
import { allAnswers, getAnswer } from '~/lib/answers/index';
import { answerJsonLd } from '~/lib/answers/structured-data';
import { intakePrefill } from '~/lib/intake-prefill';
import { pageSource } from '~/lib/page-source';
import { notFoundMetadata } from '~/lib/site/not-found-copy';
import { answerShareImage, shareQueryForRequest } from '~/lib/site/share-cards';
import { readSmsNumber } from '~/lib/text-entry';

interface PageProps {
  params: Promise<{ locale: Locale; slug: string }>;
  searchParams?: Promise<{ s?: string | string[] }>;
}

export function generateStaticParams(): { slug: string }[] {
  return allAnswers.map((a) => ({ slug: a.slug }));
}

export async function generateMetadata({ params, searchParams }: PageProps): Promise<Metadata> {
  const { locale, slug } = await params;
  const page = getAnswer(slug);
  const query = await shareQueryForRequest(locale, await searchParams);
  // An unknown slug is a 404. Returning {} would leave the homepage title on
  // the tab; the not-found title is the same string the 404 page emits.
  if (!page) return notFoundMetadata(locale, query);

  const canonical = `/answers/${page.slug}`;
  const title = `${page.title} · Hale`;
  const image = answerShareImage(page.slug, page.question, query);
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
      url: absolutePageUrl(locale, canonical),
      siteName: 'Hale',
      locale: ogLocale(locale),
      images: [image],
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description: page.description,
      images: [image],
    },
  };
}

export default async function AnswerRoute({ params, searchParams }: PageProps) {
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
        source={await pageSource(searchParams)}
      />
    </>
  );
}
