import { ArrowUpRight } from 'lucide-react';
import type { Metadata } from 'next';
import { CtaBand } from '~/components/cta-band';
import { Village } from '~/components/illos';
import { SiteFooter } from '~/components/site-footer';
import { SiteHeader } from '~/components/site-header';
import { APP_URL } from '~/lib/app-url';

export const metadata: Metadata = {
  title: 'About · Hale',
  description:
    'Hale puts the village back online — the trusted, word-of-mouth network parents used to have, rebuilt so it grows with every family that joins. Built by Anzhe Dong at Village Hale Technologies Inc. in Georgetown, Ontario.',
};

const SOCIALS = [
  { label: 'LinkedIn', href: 'https://www.linkedin.com/in/anzhe-dong/' },
  { label: 'X', href: 'https://x.com/therealbossdong' },
  { label: 'GitHub', href: 'https://github.com/donganzh' },
] as const;

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
        <div className="band-cream rounded-[24px] px-8 py-14 sm:px-14 sm:py-20 lg:px-20 rise rise-2">
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
        <div className="max-w-2xl rise rise-1">
          <span className="eyebrow">The founder</span>
          <h2 className="mt-3">Built by a parent, far from his village.</h2>
          <p
            className="mt-5 text-lg"
            style={{ color: 'var(--color-slate-green)', lineHeight: 1.6 }}
          >
            Hale is built by Anzhe Dong — an AI agent engineer who builds
            production agentic systems for a living. He started it raising a kid
            far from the village his own parents had: no elders down the street,
            no one who just knew which class was worth it. The trust was still out
            there, in what other parents told each other; it just couldn’t reach
            him. So he built a way to put it online.
          </p>
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
          Your village starts the day you join — one family, then a street, then a
          neighborhood.
        </p>
        <div className="mt-8 flex justify-center">
          <a href={`${APP_URL}/sign-up`} className="btn-on-navy">
            Join the village
          </a>
        </div>
      </CtaBand>

      <SiteFooter />
    </main>
  );
}
