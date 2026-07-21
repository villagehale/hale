import { Sparkles } from 'lucide-react';
import type { Metadata } from 'next';
import { CtaBand } from '~/components/cta-band';
import { PricingSection } from '~/components/pricing-section';
import { SiteFooter } from '~/components/site-footer';
import { SiteHeader } from '~/components/site-header';
import { APP_URL } from '~/lib/app-url';

const TITLE = 'Pricing · Hale';
const DESCRIPTION =
  'Hale is free while we build the village — every stage, every child. Plus and Family add more automation and booking on your approval as integrations ship. Your data stays in Canada.';

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: '/pricing' },
  openGraph: {
    type: 'website',
    title: TITLE,
    description: DESCRIPTION,
    url: '/pricing',
    siteName: 'Hale',
    locale: 'en_CA',
  },
  twitter: { card: 'summary_large_image', title: TITLE, description: DESCRIPTION },
};

export default function PricingPage() {
  return (
    <main id="main" tabIndex={-1} className="relative">
      <SiteHeader />

      <section className="shell pt-10 sm:pt-16 pb-8 lg:pb-10">
        <div className="max-w-2xl rise rise-1">
          <span className="pill-eyebrow">
            <Sparkles size={14} strokeWidth={2} aria-hidden="true" />
            Pricing
          </span>
          <h1 className="mt-4">
            Hale is free while we <span className="accent">build the village</span>.
          </h1>
          <p className="meta mt-6 text-lg" style={{ lineHeight: 1.6 }}>
            The whole core — every stage, every child — is free. Plus and Family add more of the
            work Hale does for you, on your approval, as each integration ships.
          </p>
        </div>
      </section>

      <PricingSection />

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
          Start free today — and let Hale grow into the rest when you’re ready.
        </p>
        <div className="mt-8 flex justify-center">
          <a href={`${APP_URL}/onboarding`} className="btn-on-navy">
            Join free
          </a>
        </div>
      </CtaBand>

      <SiteFooter />
    </main>
  );
}
