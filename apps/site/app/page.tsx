import { ArrowRight, ArrowUpRight, Mic, SendHorizonal, Sparkles } from 'lucide-react';
import Image from 'next/image';
import { Fragment } from 'react';
import village from '~/assets/village-illustration-alpha.png';
import { AnimatedText } from '~/components/landing/animated-text';
import { FadeInUp } from '~/components/landing/fade-in-up';
import { HeroBackdrop } from '~/components/landing/hero-backdrop';
import { FaqAccordion } from '~/components/landing/faq-accordion';
import { Testimonials } from '~/components/landing/testimonials';
import { LandingCta } from '~/components/landing-cta';
import { SiteFooter } from '~/components/site-footer';
import { SiteHeader } from '~/components/site-header';
import { APP_URL } from '~/lib/app-url';
import { siteJsonLd } from '~/lib/site/structured-data';

// The landing funnel starts the public onboarding wizard (steps 1–6 build the
// village before the account ask at step 6), not the account form directly.
const SIGN_UP = `${APP_URL}/onboarding`;
const PREVIEW = `${APP_URL}/preview`;

// Real parent quotes are not collected yet; the testimonials band stays gated
// off unless NEXT_PUBLIC_SHOW_TESTIMONIALS is explicitly enabled.
const SHOW_TESTIMONIALS = process.env.NEXT_PUBLIC_SHOW_TESTIMONIALS === 'true';

// Honest trust posture — a single quiet static line under the features (no
// fabricated logos or counts). Each maps to a real Hale rule: approval-first
// flow, PIPEDA/Law 25, Canadian residency, 0–18 scope, private by default.
const TRUST_POINTS = [
  'Approval-first',
  'PIPEDA-compliant',
  'Data stays in Canada',
  'Newborn to eighteen',
  'Private by default',
] as const;

const HERO_SUBTEXT =
  'Hale quietly prepares the helpful things — reminders, logs, plans, local ideas — and never acts without your say-so.';

export default function LandingPage() {
  return (
    <main id="main" tabIndex={-1} className="relative bg-[#FDFCFA] text-[#17294A]">
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: JSON-LD is a serialized in-repo data object (no user input) — the standard way to emit SEO structured data.
        dangerouslySetInnerHTML={{ __html: JSON.stringify(siteJsonLd()) }}
      />

      <SiteHeader />

      {/* ── 1 · Hero — cinematic, bottom-anchored over the village ────────── *
       * Full-viewport stage: the village illustration is a full-bleed backdrop
       * (HeroBackdrop), the transparent nav floats over its light upper area,
       * and the copy is anchored bottom-left on the navy-tinted band. Elements
       * arrive in sequence — badge, then the headline/subtext word-by-word,
       * then the buttons. `-mt-[4.5rem]` tucks the stage up under the sticky
       * 4.5rem header so the art reads behind it. */}
      <section
        id="about"
        className="relative isolate -mt-[4.5rem] flex min-h-screen flex-col justify-end overflow-hidden px-6 pb-16 pt-[4.5rem] md:pb-20"
      >
        <HeroBackdrop />

        <div
          className="mx-auto flex w-full max-w-[1340px] flex-col items-start"
          style={{ textShadow: '0 1px 16px rgba(23,41,74,0.45)' }}
        >
          <span className="rise rise-1 inline-flex items-center gap-2 rounded-full border border-white/25 bg-[#17294A]/40 px-3 py-1.5 text-sm font-normal text-[#F7F4EC] backdrop-blur-md">
            <span className="rounded-full bg-[#F7F4EC] px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-[#17294A]">
              Free
            </span>
            Built in Canada — private by default
          </span>

          <span
            className="rise rise-2 mt-5 text-xs font-semibold uppercase tracking-[0.16em] text-[#F7F4EC]"
            style={{ textShadow: '0 1px 10px rgba(23,41,74,0.85)' }}
          >
            Toronto and the GTA
          </span>

          <h1 className="mt-3 max-w-4xl text-[40px] font-medium leading-[1.1] tracking-tight text-[#F7F4EC] md:text-6xl lg:text-[64px]">
            <span className="block">
              <RevealWords text="Parenting was never meant" baseMs={180} />
            </span>
            <span className="block">
              <RevealWords text="to be done" baseMs={340} />
              <span
                className="hale-hero-word font-serif font-normal italic"
                style={{ animationDelay: '460ms' }}
              >
                alone.
              </span>
            </span>
          </h1>

          <p className="mt-6 max-w-xl text-[15px] leading-relaxed text-[#F7F4EC]/85 md:text-[17px]">
            <RevealWords text={HERO_SUBTEXT} baseMs={560} stepMs={22} />
          </p>

          <div
            className="rise mt-9 flex flex-col items-start gap-3 sm:flex-row sm:items-center"
            style={{ animationDelay: '780ms', textShadow: 'none' }}
          >
            <LandingCta
              event="landing_cta_signin"
              href={SIGN_UP}
              className="group inline-flex items-center gap-1.5 rounded-full bg-[#F7F4EC] px-[26px] py-3 text-base font-semibold text-[#17294A] shadow-[0_12px_30px_-12px_rgba(0,0,0,0.5)] transition-transform hover:scale-105 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#F7F4EC] motion-reduce:transition-none"
            >
              Join free — Toronto and the GTA
              <ArrowRight
                size={17}
                strokeWidth={2}
                aria-hidden="true"
                className="transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none"
              />
            </LandingCta>
            <LandingCta
              event="landing_cta_preview"
              href={PREVIEW}
              className="inline-flex items-center gap-1.5 rounded-full border border-[#F7F4EC]/40 px-[26px] py-3 text-base font-semibold text-[#F7F4EC] transition-colors hover:bg-[#F7F4EC] hover:text-[#17294A] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#F7F4EC] motion-reduce:transition-none"
            >
              See what Hale finds for you
              <ArrowRight size={17} strokeWidth={2} aria-hidden="true" />
            </LandingCta>
          </div>

          <a
            href="#features"
            className="rise mt-5 text-sm font-medium text-[#F7F4EC]/80 underline decoration-[#F7F4EC]/30 underline-offset-4 transition-colors hover:text-[#F7F4EC] hover:decoration-[#F7F4EC]"
            style={{ animationDelay: '900ms' }}
          >
            See how it works
          </a>
        </div>
      </section>

      {/* ── 1b · Village narrative — brand + SEO lead-in (from the live page) ── */}
      <FadeInUp>
        <section className="mx-auto max-w-3xl px-6 pt-20 text-center md:pt-28">
          <p className="text-lg leading-relaxed text-[#5C6B87] md:text-xl">
            Hale turns the trusted, word-of-mouth village parents used to have — the neighbour who
            knew which class was worth it — into one you can actually reach, near you, online.
          </p>
        </section>
      </FadeInUp>

      {/* ── 2 · Feature — Ask Hale ────────────────────────────────────────── */}
      <FadeInUp>
        <section id="features" className="mx-auto max-w-7xl px-6 pb-24 pt-16">
          <div className="grid items-center gap-16 lg:grid-cols-2">
            <div>
              <span className="inline-flex items-center gap-1.5 rounded-full bg-[#FEF0C7] px-3.5 py-1.5 text-xs font-semibold text-[#B26B1F]">
                <Sparkles size={13} strokeWidth={2} aria-hidden="true" />
                Ask Hale
              </span>
              <h2 className="mt-6 text-4xl font-semibold tracking-tight text-[#17294A] md:text-5xl">
                One quiet helper for the whole household.
              </h2>
              <p className="mt-6 max-w-xl text-lg leading-relaxed text-[#5C6B87]">
                Ask Hale to log a nap in a sentence, draft the daycare email, or find something to do
                this weekend. It prepares each one and waits — every action needs your approval
                before anything happens.
              </p>
              <div className="mt-8">
                <LandingCta
                  event="landing_cta_signin"
                  href={SIGN_UP}
                  className="inline-flex items-center justify-center rounded-full bg-[#17294A] px-6 py-3 text-base font-semibold text-[#F7F4EC] transition-colors hover:bg-[#101d36] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#17294A]"
                >
                  Get started
                </LandingCta>
              </div>
            </div>

            <AskHaleMockup />
          </div>
        </section>
      </FadeInUp>

      {/* ── 3 · Feature — Your Village (mirrored) ─────────────────────────── */}
      <FadeInUp>
        <section className="mx-auto max-w-7xl px-6 py-24">
          <div className="grid items-center gap-16 lg:grid-cols-2">
            <div className="lg:order-2">
              <span className="inline-flex items-center gap-1.5 rounded-full border border-[#17294A]/25 bg-white px-3.5 py-1.5 text-xs font-semibold text-[#17294A]">
                <Sparkles size={13} strokeWidth={2} aria-hidden="true" />
                Your Village
              </span>
              <h2 className="mt-6 text-4xl font-semibold tracking-tight text-[#17294A] md:text-5xl">
                Your neighbourhood, working for you.
              </h2>
              <p className="mt-6 max-w-xl text-lg leading-relaxed text-[#5C6B87]">
                Storytimes, classes, childcare options and local resources near you — surfaced and
                tuned to your kids&rsquo; ages, so the good stuff is easy to find.
              </p>
              <div className="mt-8">
                <LandingCta
                  event="landing_cta_signin"
                  href={SIGN_UP}
                  className="inline-flex items-center justify-center rounded-full bg-[#17294A] px-6 py-3 text-base font-semibold text-[#F7F4EC] transition-colors hover:bg-[#101d36] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#17294A]"
                >
                  Get started
                </LandingCta>
              </div>
            </div>

            <VillageMockup />
          </div>
        </section>
      </FadeInUp>

      {/* ── 3b · Quiet static trust line (replaces the removed marquee) ────── */}
      <p className="mx-auto max-w-4xl px-6 text-center text-sm text-[#5C6B87]">
        {TRUST_POINTS.join(' · ')}
      </p>

      {/* ── 4 · Testimonials (gated) ──────────────────────────────────────── */}
      {SHOW_TESTIMONIALS && <Testimonials />}

      {/* ── 5 · FAQ ───────────────────────────────────────────────────────── */}
      <section id="faq" className="mx-auto max-w-[1440px] px-6 pb-24 pt-24 md:px-12 md:pt-32 lg:px-24">
        <div className="grid gap-8 lg:grid-cols-12 lg:gap-16">
          <div className="lg:col-span-4">
            <div className="flex items-center gap-2.5">
              <span aria-hidden className="h-1.5 w-1.5 bg-[#17294A]" />
              <AnimatedText
                text="About Hale"
                className="text-sm font-semibold uppercase tracking-[0.08em] text-[#5C6B87]"
              />
            </div>
          </div>
          <div className="lg:col-span-8 lg:max-w-[54rem]">
            <AnimatedText
              as="h2"
              text="Frequently asked questions"
              stepMs={50}
              className="mb-16 block text-4xl font-medium leading-[1.05] tracking-tight text-[#17294A] md:text-5xl lg:text-7xl"
            />
            <FaqAccordion />
          </div>
        </div>
      </section>

      {/* ── 6 · Navy CTA band + footer ────────────────────────────────────── */}
      <FadeInUp>
        <section id="contact" className="px-4 py-16 sm:px-6">
          <div className="mx-auto max-w-[1100px] rounded-[28px] bg-[#17294A] px-6 py-16 text-center md:py-24">
            <h2 className="mx-auto max-w-3xl text-4xl font-medium tracking-tight text-[#F7F4EC] md:text-5xl">
              Ready to feel <span className="font-serif font-normal italic">on top of it all?</span>
            </h2>
            <p className="mx-auto mt-5 max-w-xl text-base leading-relaxed text-[#F7F4EC]/70">
              One quiet helper, always prepared — and never a step you didn&rsquo;t approve.
            </p>
            <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <LandingCta
                event="landing_cta_signin"
                href={SIGN_UP}
                className="inline-flex items-center justify-center rounded-full bg-[#F7F4EC] px-7 py-3.5 text-base font-semibold text-[#17294A] transition-transform hover:-translate-y-0.5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#F7F4EC]"
              >
                Get started
              </LandingCta>
              <a
                href="/contact"
                className="inline-flex items-center justify-center gap-1.5 rounded-full border border-[#F7F4EC]/30 px-7 py-3.5 text-base font-semibold text-[#F7F4EC] transition-colors hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#F7F4EC]"
              >
                Questions? Contact us
                <ArrowUpRight size={18} strokeWidth={2} aria-hidden="true" />
              </a>
            </div>
          </div>
        </section>
      </FadeInUp>

      <SiteFooter />
    </main>
  );
}

/**
 * Renders text as word-by-word rising spans for the hero's on-load reveal. Words
 * stay real text in the DOM (SEO-safe); each span carries a staggered CSS delay.
 * `.hale-hero-word` holds still under prefers-reduced-motion.
 */
function RevealWords({
  text,
  baseMs,
  stepMs = 40,
}: {
  text: string;
  baseMs: number;
  stepMs?: number;
}) {
  return (
    <>
      {text.split(' ').map((word, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a static word split that never reorders — the index disambiguates repeated words.
        <Fragment key={`${word}-${i}`}>
          <span className="hale-hero-word" style={{ animationDelay: `${baseMs + i * stepMs}ms` }}>
            {word}
          </span>{' '}
        </Fragment>
      ))}
    </>
  );
}

/** Pure HTML/CSS product mockup of the approval-first Ask Hale flow. Illustrative. */
function AskHaleMockup() {
  return (
    <div className="rounded-3xl border border-[#E4E7EE] bg-gradient-to-br from-[#FFF9F1] to-[#FBEDDC] p-6 sm:p-8">
      <div className="hale-card-in hale-float rounded-2xl bg-[#17294A]/95 p-4 shadow-[0_24px_60px_-20px_rgba(20,26,77,0.55)] backdrop-blur">
        <div className="flex flex-wrap gap-2">
          {['Log a nap', 'Draft daycare email', 'Find weekend ideas'].map((chip) => (
            <span
              key={chip}
              className="rounded-full bg-white/10 px-3 py-1.5 text-xs font-medium text-[#F7F4EC]/85"
            >
              {chip}
            </span>
          ))}
        </div>

        <div className="mt-4 flex flex-col gap-3">
          <p className="ml-auto max-w-[80%] rounded-2xl rounded-br-sm bg-white/12 px-4 py-2.5 text-sm text-[#F7F4EC]">
            Can you log Mia&rsquo;s afternoon nap? 1:30 to 3.
          </p>

          <div className="mr-auto max-w-[88%] rounded-2xl rounded-bl-sm border border-white/12 bg-white/8 p-3">
            <p className="text-[11px] font-medium uppercase tracking-wide text-[#F7F4EC]/55">
              Draft ready · needs your approval
            </p>
            <p className="mt-1 text-sm text-[#F7F4EC]">Log nap — Mia, 1:30–3:00 PM</p>
            <div className="mt-3 flex gap-2">
              <span className="rounded-full bg-[#F7F4EC] px-3 py-1.5 text-xs font-semibold text-[#17294A]">
                Approve
              </span>
              <span className="rounded-full border border-white/25 px-3 py-1.5 text-xs font-medium text-[#F7F4EC]/80">
                Not now
              </span>
            </div>
          </div>
        </div>

        <div className="mt-4 flex items-center gap-2 rounded-full bg-white/10 px-3 py-2">
          <span className="flex-1 text-sm text-[#F7F4EC]/50">Ask anything…</span>
          <Mic size={18} strokeWidth={1.75} className="text-[#F7F4EC]/60" aria-hidden />
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[#F7F4EC]">
            <SendHorizonal size={16} strokeWidth={2} className="text-[#17294A]" aria-hidden />
          </span>
        </div>
      </div>
    </div>
  );
}

/** Pure HTML/CSS mockup: the village illustration with an illustrative activity card. */
function VillageMockup() {
  return (
    <div className="lg:order-1">
      <div className="relative overflow-hidden rounded-3xl border border-[#E4E7EE] bg-gradient-to-br from-[#F7F5F0] to-[#FDFCFA] p-6 sm:p-8">
        <Image
          src={village}
          alt=""
          aria-hidden
          width={1254}
          height={1254}
          sizes="(max-width: 1024px) 100vw, 50vw"
          className="mx-auto h-auto w-full max-w-md"
          priority={false}
        />
        <div className="hale-float mt-[-2rem] rounded-2xl border border-[#E4E7EE] bg-white p-4 shadow-[0_20px_50px_-20px_rgba(20,26,77,0.25)] sm:absolute sm:bottom-8 sm:right-8 sm:mt-0 sm:w-64">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold uppercase tracking-wide text-[#5C6B87]">Near you</p>
            <p className="text-[10px] text-[#5C6B87]">Illustrative</p>
          </div>
          <ul className="mt-3 flex flex-col gap-2.5">
            {[
              { color: '#B26B1F', label: 'Storytime · Sat 10:30' },
              { color: '#17294A', label: 'Toddler swim · Sun 9:00' },
              { color: '#8B95A9', label: 'Nature walk · Sat 2:00' },
            ].map((row) => (
              <li key={row.label} className="flex items-center gap-2.5">
                <span
                  aria-hidden
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ background: row.color }}
                />
                <span className="text-sm text-[#17294A]">{row.label}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
