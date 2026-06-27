import type { Metadata } from 'next';
import { ParentAndHouse, Village } from '~/components/illos';
import { SiteFooter } from '~/components/site-footer';
import { SiteHeader } from '~/components/site-header';
import { APP_URL } from '~/lib/app-url';

export const metadata: Metadata = {
  title: 'About · Hale',
  description:
    'Hale puts the village back online — the trusted, word-of-mouth network parents used to have, rebuilt so it grows with every family that joins. Built by Village Hale Technologies Inc. in Georgetown, Ontario.',
};

export default function AboutPage() {
  return (
    <main id="top" className="relative">
      <SiteHeader />

      <section className="shell pt-10 sm:pt-16 pb-16 lg:pb-24">
        <div className="max-w-2xl rise rise-1">
          <span className="eyebrow">About Hale</span>
          <h1 className="mt-3">
            Putting the <span className="accent">village</span> back online.
          </h1>
          <p
            className="mt-6 text-lg"
            style={{ color: 'var(--color-slate-green)', lineHeight: 1.6 }}
          >
            Once, a family had a village — elders who knew which class was worth it,
            neighbors who carried the small things, a grandmother who said this is
            normal, you are doing fine. That trust still lives in word-of-mouth
            between parents. It just doesn’t scale, and you can’t reach it when you
            move. Hale is how we give it back.
          </p>
        </div>
      </section>

      <section className="shell pb-16 lg:pb-24">
        <div className="panel-oat px-8 py-14 sm:px-14 sm:py-20 lg:px-20 rise rise-2">
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
                Every parent deserves a village — the genuinely good local things
                families near them swear by, in one place, easy to share, growing
                with every family that joins. Across every stage of childhood, from
                the first months to almost grown.
              </p>
            </div>
            <div className="lg:col-span-4 flex justify-center lg:justify-end">
              <Village style={{ width: 'clamp(180px, 30vw, 240px)', height: 'auto' }} />
            </div>
          </div>
        </div>
      </section>

      <section className="shell pb-16 lg:pb-24">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-10 lg:gap-x-16 items-start">
          <div className="lg:col-span-7 rise rise-1">
            <span className="eyebrow">What Hale is</span>
            <h2 className="mt-3">A trusted network, not a directory.</h2>
            <p
              className="mt-5 text-lg"
              style={{ color: 'var(--color-slate-green)', lineHeight: 1.6 }}
            >
              Hale gathers what families like yours actually recommend near you, and
              makes it one tap to share what you love. A calm AI concierge finds and
              organizes it — and, only once you’ve let it, drafts the small tasks for
              your approval. The village is the point; the concierge is how it gets
              done.
            </p>
            <p
              className="mt-4"
              style={{ color: 'var(--color-faded-sage)', lineHeight: 1.55 }}
            >
              We handle newborn and childhood data — among the most sensitive data
              there is — so trust is the product. Your family’s data stays in Canada,
              and Hale never acts on its own. PIPEDA, Quebec Law 25, and CASL
              compliant by default.
            </p>
          </div>

          <div className="lg:col-span-5 rise rise-2">
            <span className="eyebrow">The company</span>
            <h2 className="mt-3">Village Hale Technologies Inc.</h2>
            <p
              className="mt-5 text-lg"
              style={{ color: 'var(--color-slate-green)', lineHeight: 1.6 }}
            >
              Hale is built by Village Hale Technologies Inc., a company incorporated
              in Ontario and based in Georgetown, ON. We’re small, parent-built, and
              early — this is a research preview.
            </p>
            <p className="mt-6">
              <a href="/contact" className="link">
                Get in touch
              </a>
            </p>
            <div className="mt-10 flex justify-center lg:justify-start">
              <ParentAndHouse style={{ width: 'clamp(140px, 22vw, 180px)', height: 'auto' }} />
            </div>
          </div>
        </div>
      </section>

      <section className="shell pb-20 lg:pb-28">
        <div className="panel-apricot-tint px-8 py-14 sm:px-12 flex flex-col sm:flex-row sm:items-center gap-6 sm:gap-10 rise rise-1">
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
            Your village starts the day you join — one family, then a street, then a
            neighborhood.
          </p>
          <a href={`${APP_URL}/sign-in`} className="btn-primary shrink-0">
            Join the village
          </a>
        </div>
      </section>

      <SiteFooter />
    </main>
  );
}
