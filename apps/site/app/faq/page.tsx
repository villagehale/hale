import type { Metadata } from 'next';
import { LandingCta } from '~/components/landing-cta';
import { SiteFooter } from '~/components/site-footer';
import { SiteHeader } from '~/components/site-header';
import { APP_URL } from '~/lib/app-url';
import { FAQ, faqJsonLd } from '~/lib/faq/index';

const TITLE = 'Is Hale free, private, and right for your family? · Hale';
const DESCRIPTION =
  'Straight answers about Hale for parents: it’s free to start, your family’s data stays in Canada, it works for every age 0–18, and it never acts without your consent.';

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: '/faq' },
  openGraph: {
    type: 'website',
    title: TITLE,
    description: DESCRIPTION,
    url: '/faq',
    siteName: 'Village Hale',
    locale: 'en_CA',
  },
  twitter: { card: 'summary_large_image', title: TITLE, description: DESCRIPTION },
};

export default function FaqPage() {
  return (
    <main id="top" className="relative">
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: JSON-LD is a serialized in-repo data object (no user input) — the standard way to emit SEO structured data.
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd()) }}
      />
      <SiteHeader />

      <section className="shell pt-10 sm:pt-16 pb-16 lg:pb-24">
        <div className="max-w-2xl rise rise-1">
          <span className="eyebrow">Questions, answered</span>
          <h1 className="mt-3">
            Is Hale right for <span className="accent">your family?</span>
          </h1>
          <p className="meta mt-6 text-lg" style={{ lineHeight: 1.6 }}>
            The honest answers parents ask us most — about cost, privacy, and how Hale actually
            works.
          </p>
        </div>

        <dl className="mt-14 flex flex-col gap-10 max-w-2xl">
          {FAQ.map((item) => (
            <div key={item.question} className="rise rise-2 border-t border-rule pt-8">
              <dt className="font-display text-xl sm:text-2xl text-spruce">{item.question}</dt>
              <dd className="meta mt-4" style={{ lineHeight: 1.65 }}>
                {item.answer}
              </dd>
            </div>
          ))}
        </dl>

        <div className="mt-16 max-w-2xl rise rise-2">
          <div className="panel-apricot-tint px-8 py-12 sm:px-12">
            <h2 className="font-display text-2xl text-spruce">Ready to find your village?</h2>
            <p className="meta mt-3" style={{ lineHeight: 1.6 }}>
              Free to start. Your data stays in Canada.
            </p>
            <LandingCta
              event="faq_cta_signin"
              href={`${APP_URL}/sign-in`}
              className="btn-primary mt-6 inline-flex"
            >
              Join the village
            </LandingCta>
          </div>
        </div>
      </section>

      <SiteFooter />
    </main>
  );
}
