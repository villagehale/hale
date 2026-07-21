import type { Metadata } from 'next';
import { SiteFooter } from '~/components/site-footer';
import { SiteHeader } from '~/components/site-header';
import { publishedAnswers } from '~/lib/answers/index';
import { APP_URL } from '~/lib/app-url';

const STAGE_LABEL: Record<string, string> = {
  newborn: 'Newborn · 0–11 months',
  toddler: 'Toddler · 1–3 years',
  child: 'School age · 4–12 years',
  teenager: 'Teenager · 13+ years',
};

// The index only lists reviewed (published) answers. Until at least one page is
// published it has nothing to index, so it stays out of search — it becomes
// indexable on its own once the first answer goes live.
export const metadata: Metadata = {
  title: 'Answers · Hale',
  description:
    'Calm, cited answers to the parenting-health questions families search for — general guidance, grounded in trusted frameworks, never a substitute for your provider.',
  alternates: { canonical: '/answers' },
  robots: publishedAnswers.length > 0 ? undefined : { index: false, follow: true },
};

export default function AnswersIndexPage() {
  const answers = publishedAnswers;

  return (
    <main id="top" className="relative">
      <SiteHeader />

      <section className="shell pt-10 sm:pt-16 pb-12">
        <div className="max-w-2xl rise rise-1">
          <span className="eyebrow">Answers</span>
          <h1 className="mt-3">
            Calm, cited answers for <span className="accent">every stage</span>.
          </h1>
          <p
            className="mt-6 text-lg"
            style={{ color: 'var(--color-slate-green)', lineHeight: 1.6 }}
          >
            Plain answers to the questions parents actually search — each one grounded in trusted
            parenting-health frameworks and honest about its limits. General guidance, never a
            replacement for your provider.
          </p>
        </div>
      </section>

      {answers.length > 0 ? (
        <div className="band-cream">
          <section className="shell py-16 lg:py-24">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 lg:gap-8">
              {answers.map((page) => (
                <a
                  key={page.slug}
                  href={`/answers/${page.slug}`}
                  className="card lift flex flex-col gap-3"
                >
                  <span className="eyebrow">{STAGE_LABEL[page.stage]}</span>
                  <span
                    className="font-display"
                    style={{ fontWeight: 600, fontSize: '1.2rem', lineHeight: 1.25 }}
                  >
                    {page.question}
                  </span>
                  <span className="meta" style={{ lineHeight: 1.5 }}>
                    {page.description}
                  </span>
                </a>
              ))}
            </div>
          </section>
        </div>
      ) : (
        <section className="shell pb-20 lg:pb-28">
          <div className="panel-oat px-8 py-14 sm:px-12 max-w-2xl rise rise-2">
            <p className="text-lg" style={{ color: 'var(--color-slate-green)', lineHeight: 1.6 }}>
              Our first answers are in review. In the meantime, the fastest way to get an answer for
              your own child — with their age and your family in mind — is to ask Concierge.
            </p>
            <div className="mt-8">
              <a href={`${APP_URL}/sign-up`} className="btn-primary">
                Ask Concierge about your child
              </a>
            </div>
          </div>
        </section>
      )}

      <SiteFooter />
    </main>
  );
}
