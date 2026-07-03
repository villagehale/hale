import { ArrowUpRight } from 'lucide-react';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { SiteFooter } from '~/components/site-footer';
import { SiteHeader } from '~/components/site-header';
import { allAnswers, getAnswer } from '~/lib/answers/index';
import { FRAMEWORK_SOURCES } from '~/lib/answers/frameworks';
import { answerJsonLd } from '~/lib/answers/structured-data';
import { APP_URL } from '~/lib/app-url';

interface PageProps {
  params: Promise<{ slug: string }>;
}

const STAGE_LABEL: Record<string, string> = {
  newborn: 'Newborn · 0–11 months',
  toddler: 'Toddler · 1–3 years',
  child: 'School age · 4–12 years',
  teenager: 'Teenager · 13+ years',
};

export function generateStaticParams(): { slug: string }[] {
  return allAnswers.map((a) => ({ slug: a.slug }));
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const page = getAnswer(slug);
  if (!page) return {};

  const canonical = `/answers/${page.slug}`;
  return {
    title: `${page.title} · Hale`,
    description: page.description,
    alternates: { canonical },
    // Review-before-index gate: a draft stays out of the index until a human
    // flips `published`. Published pages get the default (indexable) directive.
    robots: page.published ? undefined : { index: false, follow: true },
    openGraph: {
      type: 'article',
      title: page.title,
      description: page.description,
      url: canonical,
      siteName: 'Hale',
      locale: 'en_CA',
    },
    twitter: {
      card: 'summary_large_image',
      title: page.title,
      description: page.description,
    },
  };
}

export default async function AnswerRoute({ params }: PageProps) {
  const { slug } = await params;
  const page = getAnswer(slug);
  if (!page) notFound();

  const related = page.related.map(getAnswer).filter((p) => p !== undefined);

  return (
    <main id="top" className="relative">
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: JSON-LD is a serialized in-repo data object (no user input) — the standard way to emit SEO structured data.
        dangerouslySetInnerHTML={{ __html: JSON.stringify(answerJsonLd(page)) }}
      />
      <SiteHeader />

      <article className="shell pt-10 sm:pt-16 pb-16 lg:pb-24">
        <div className="max-w-3xl">
          <nav aria-label="Breadcrumb" className="rise rise-1">
            <a href="/answers" className="link text-sm">
              Answers
            </a>
          </nav>

          <div className="mt-4 rise rise-1">
            <span className="eyebrow">{STAGE_LABEL[page.stage]}</span>
            <h1 className="mt-3">{page.question}</h1>
          </div>

          <p
            className="mt-7 text-lg rise rise-2"
            style={{ color: 'var(--color-slate-green)', lineHeight: 1.6 }}
          >
            {page.answer}
          </p>

          <p className="meta mt-4 rise rise-2">
            General guidance, last reviewed {page.updated} — not medical advice.
          </p>

          <div className="mt-12 flex flex-col gap-12">
            {page.sections.map((section) => (
              <section key={section.heading} className="rise rise-2">
                <h2 style={{ fontSize: 'clamp(1.5rem, 3vw, 2.1rem)' }}>{section.heading}</h2>
                <div className="mt-4 flex flex-col gap-4">
                  {section.body.map((paragraph) => (
                    <p
                      key={paragraph.slice(0, 48)}
                      className="text-lg"
                      style={{ color: 'var(--color-slate-green)', lineHeight: 1.65 }}
                    >
                      {paragraph}
                    </p>
                  ))}
                </div>
              </section>
            ))}
          </div>

          {page.faqs.length > 0 && (
            <section className="mt-14 rise rise-2">
              <h2 style={{ fontSize: 'clamp(1.5rem, 3vw, 2.1rem)' }}>Parents also ask</h2>
              <dl className="mt-6 flex flex-col gap-6">
                {page.faqs.map((faq) => (
                  <div key={faq.question} className="panel-oat px-6 py-6 sm:px-8">
                    <dt className="font-display" style={{ fontWeight: 600, fontSize: '1.15rem' }}>
                      {faq.question}
                    </dt>
                    <dd
                      className="mt-3"
                      style={{ color: 'var(--color-slate-green)', lineHeight: 1.6 }}
                    >
                      {faq.answer}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          )}

          <section className="mt-14 rise rise-2">
            <h2 style={{ fontSize: 'clamp(1.5rem, 3vw, 2.1rem)' }}>Sources</h2>
            <p className="meta mt-3">
              Every claim on this page is attributed to one of the parenting-health frameworks Hale
              draws from. Follow a source to read it directly.
            </p>
            <ul className="mt-6 flex flex-col gap-5">
              {page.citations.map((citation) => (
                <li key={citation.reference}>
                  <a
                    href={FRAMEWORK_SOURCES[citation.framework].home}
                    target="_blank"
                    rel="noreferrer"
                    className="link inline-flex items-center gap-1.5"
                  >
                    {FRAMEWORK_SOURCES[citation.framework].label}
                    <ArrowUpRight size={14} strokeWidth={2.25} aria-hidden="true" />
                  </a>
                  <p className="meta mt-1.5">{citation.reference}</p>
                  {citation.excerpt && (
                    <p
                      className="mt-1.5"
                      style={{
                        color: 'var(--color-slate-green)',
                        lineHeight: 1.55,
                        fontStyle: 'italic',
                      }}
                    >
                      “{citation.excerpt}”
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </section>
        </div>
      </article>

      <section className="shell pb-16 lg:pb-24">
        <div className="night px-8 py-12 sm:px-14 sm:py-16 max-w-3xl" style={{ borderRadius: 'var(--r-xl)' }}>
          <span className="eyebrow" style={{ color: 'var(--color-on-spruce-soft)' }}>
            Please read
          </span>
          <h2 className="mt-3" style={{ color: 'var(--color-on-spruce)', fontSize: 'clamp(1.5rem, 3vw, 2.1rem)' }}>
            This is general guidance, not medical advice.
          </h2>
          <p className="mt-4" style={{ color: 'var(--color-on-spruce-soft)', lineHeight: 1.6 }}>
            Hale summarizes widely recommended, cited parenting-health guidance. It cannot see your
            child, and it does not diagnose, prescribe, or interpret symptoms. For anything about
            your child’s health — including diagnosis, dosing, or symptoms — talk to your
            pediatrician or health provider. In an emergency, contact your local emergency services.
          </p>
        </div>
      </section>

      <section className="shell pb-16 lg:pb-24">
        <div className="panel-apricot-tint px-8 py-14 sm:px-12 flex flex-col sm:flex-row sm:items-center gap-6 sm:gap-10 max-w-3xl">
          <p
            className="font-display"
            style={{
              fontSize: 'clamp(1.25rem, 2.4vw, 1.75rem)',
              lineHeight: 1.3,
              letterSpacing: 'var(--tracking-display)',
              fontWeight: 600,
              color: 'var(--color-spruce)',
            }}
          >
            Have a question about your own child? Hale answers with your child’s age and your family
            in mind.
          </p>
          <a href={`${APP_URL}/sign-in`} className="btn-primary shrink-0">
            Ask Hale about your child
          </a>
        </div>
      </section>

      {related.length > 0 && (
        <section className="shell pb-20 lg:pb-28">
          <span className="eyebrow">Related answers</span>
          <div className="mt-6 grid grid-cols-1 md:grid-cols-2 gap-6 lg:gap-8">
            {related.map((rel) => (
              <a key={rel.slug} href={`/answers/${rel.slug}`} className="card flex flex-col gap-3">
                <span className="eyebrow">{STAGE_LABEL[rel.stage]}</span>
                <span
                  className="font-display"
                  style={{ fontWeight: 600, fontSize: '1.2rem', lineHeight: 1.25 }}
                >
                  {rel.question}
                </span>
              </a>
            ))}
          </div>
        </section>
      )}

      <SiteFooter />
    </main>
  );
}
