import {
  ArrowUpRight,
  Baby,
  Lock,
  MapPin,
  Mic,
  SendHorizonal,
  Shield,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import Image from 'next/image';
import village from '~/assets/village-illustration-alpha.png';
import { AnimatedText } from '~/components/landing/animated-text';
import { FadeInUp } from '~/components/landing/fade-in-up';
import { FaqAccordion } from '~/components/landing/faq-accordion';
import { Testimonials } from '~/components/landing/testimonials';
import { LandingCta } from '~/components/landing-cta';
import { SiteFooter } from '~/components/site-footer';
import { SiteHeader } from '~/components/site-header';
import { APP_URL } from '~/lib/app-url';
import { siteJsonLd } from '~/lib/site/structured-data';

const SIGN_UP = `${APP_URL}/sign-up`;

// Real beta-parent quotes are not collected yet; the testimonials band stays
// gated off unless NEXT_PUBLIC_SHOW_TESTIMONIALS is explicitly enabled.
const SHOW_TESTIMONIALS = process.env.NEXT_PUBLIC_SHOW_TESTIMONIALS === 'true';

// Honest trust chips — no fabricated company logos. Each maps to a real Hale
// posture (approval-first flow, PIPEDA/Law 25, Canadian residency, 0–18 scope).
const TRUST_CHIPS = [
  { Icon: ShieldCheck, label: 'Approval-first' },
  { Icon: Shield, label: 'PIPEDA-compliant' },
  { Icon: MapPin, label: 'Data stays in Canada' },
  { Icon: Baby, label: 'Newborn to eighteen' },
  { Icon: Lock, label: 'Private by default' },
] as const;

export default function LandingPage() {
  return (
    <main id="top" className="relative bg-[#FDFCFA] text-[#17294A]">
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: JSON-LD is a serialized in-repo data object (no user input) — the standard way to emit SEO structured data.
        dangerouslySetInnerHTML={{ __html: JSON.stringify(siteJsonLd()) }}
      />

      <SiteHeader />

      {/* ── 1 · Hero ──────────────────────────────────────────────────────── */}
      <section
        id="about"
        className="relative flex min-h-[calc(100vh-4.5rem)] flex-col items-center justify-center overflow-hidden px-6 pb-20 pt-16 text-center"
      >
        <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
          <div
            className="hale-drift absolute -left-40 -top-32 h-[36rem] w-[36rem] rounded-full"
            style={{
              background: 'radial-gradient(circle, rgba(247,244,236,0.95), rgba(247,244,236,0) 70%)',
            }}
          />
          <div
            className="hale-drift absolute -bottom-40 -right-32 h-[34rem] w-[34rem] rounded-full"
            style={{
              background: 'radial-gradient(circle, rgba(237,240,250,0.9), rgba(237,240,250,0) 70%)',
              animationDelay: '-13s',
            }}
          />
        </div>

        <span className="rise rise-1 inline-flex items-center gap-1.5 rounded-full border border-[#E4E7EE] bg-white/60 px-3.5 py-1.5 text-xs font-medium text-[#5C6B87]">
          <Sparkles size={13} strokeWidth={2} className="text-[#B26B1F]" />
          Free while in beta
        </span>

        <h1 className="rise rise-2 mt-6 max-w-4xl text-5xl font-medium tracking-tight text-[#17294A] md:text-7xl">
          Parenting was never meant to be done{' '}
          <span className="font-serif font-normal italic">alone.</span>
        </h1>

        <p className="rise rise-3 mt-6 max-w-2xl text-base leading-relaxed text-[#5C6B87]">
          Hale quietly prepares the helpful things — reminders, logs, plans, local ideas — and never
          acts without your say-so.
        </p>

        <div className="rise rise-4 mt-9 flex flex-col items-center gap-3 sm:flex-row">
          <LandingCta
            event="landing_cta_signin"
            href={SIGN_UP}
            className="inline-flex items-center justify-center rounded-full bg-[#1B2160] px-7 py-3.5 text-base font-semibold text-[#F7F4EC] transition-colors hover:bg-[#141a4d] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1B2160]"
          >
            Get started
          </LandingCta>
          <a
            href="#features"
            className="inline-flex items-center justify-center rounded-full border border-[#E4E7EE] bg-white px-7 py-3.5 text-base font-semibold text-[#17294A] transition-colors hover:border-[#17294A] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1B2160]"
          >
            See how it works
          </a>
        </div>

        <div className="rise rise-5 mt-24 w-full max-w-6xl">
          <p className="mb-8 text-sm text-[#8B95A9]">Built for families, not feeds</p>
          <div className="hale-marquee-mask overflow-hidden">
            <div className="hale-marquee-track">
              {[0, 1].map((copy) => (
                <div key={copy} aria-hidden={copy === 1} className="flex shrink-0">
                  {TRUST_CHIPS.map((chip) => (
                    <span
                      key={chip.label}
                      className="flex shrink-0 items-center gap-2 whitespace-nowrap px-8 text-[#5C6B87]"
                    >
                      <chip.Icon size={17} strokeWidth={1.75} className="text-[#8B95A9]" />
                      <span className="text-base font-medium">{chip.label}</span>
                    </span>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ── 2 · Feature — Ask Hale ────────────────────────────────────────── */}
      <FadeInUp>
        <section id="features" className="mx-auto max-w-7xl px-6 py-24">
          <div className="grid items-center gap-16 lg:grid-cols-2">
            <div>
              <span className="inline-flex items-center gap-1.5 rounded-full bg-[#FEF0C7] px-3.5 py-1.5 text-xs font-semibold text-[#B26B1F]">
                <Sparkles size={13} strokeWidth={2} />
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
                  className="inline-flex items-center justify-center rounded-full bg-[#1B2160] px-6 py-3 text-base font-semibold text-[#F7F4EC] transition-colors hover:bg-[#141a4d] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1B2160]"
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
              <span className="inline-flex items-center gap-1.5 rounded-full bg-[#E7F6EC] px-3.5 py-1.5 text-xs font-semibold text-[#1F8A4C]">
                <Sparkles size={13} strokeWidth={2} />
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
                  className="inline-flex items-center justify-center rounded-full bg-[#1B2160] px-6 py-3 text-base font-semibold text-[#F7F4EC] transition-colors hover:bg-[#141a4d] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1B2160]"
                >
                  Get started
                </LandingCta>
              </div>
            </div>

            <VillageMockup />
          </div>
        </section>
      </FadeInUp>

      {/* ── 4 · Testimonials (gated) ──────────────────────────────────────── */}
      {SHOW_TESTIMONIALS && <Testimonials />}

      {/* ── 5 · FAQ ───────────────────────────────────────────────────────── */}
      <section id="faq" className="mx-auto max-w-[1440px] px-6 pb-24 pt-24 md:px-12 md:pt-32 lg:px-24">
        <div className="grid gap-8 lg:grid-cols-12 lg:gap-16">
          <div className="lg:col-span-4">
            <div className="flex items-center gap-2.5">
              <span aria-hidden className="h-1.5 w-1.5 bg-[#1B2160]" />
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
          <div className="mx-auto max-w-[1100px] rounded-[28px] bg-[#1B2160] px-6 py-16 text-center md:py-24">
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
                className="inline-flex items-center justify-center rounded-full bg-[#F7F4EC] px-7 py-3.5 text-base font-semibold text-[#1B2160] transition-transform hover:-translate-y-0.5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#F7F4EC]"
              >
                Get started
              </LandingCta>
              <a
                href="/contact"
                className="inline-flex items-center justify-center gap-1.5 rounded-full border border-[#F7F4EC]/30 px-7 py-3.5 text-base font-semibold text-[#F7F4EC] transition-colors hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#F7F4EC]"
              >
                Questions? Contact us
                <ArrowUpRight size={18} strokeWidth={2} />
              </a>
            </div>
          </div>
        </section>
      </FadeInUp>

      <SiteFooter />
    </main>
  );
}

/** Pure HTML/CSS product mockup of the approval-first Ask Hale flow. Illustrative. */
function AskHaleMockup() {
  return (
    <div className="rounded-3xl border border-[#E4E7EE] bg-gradient-to-br from-[#F7F5F0] to-[#EDF0FA] p-6 sm:p-8">
      <div className="hale-card-in hale-float rounded-2xl bg-[#1B2160]/95 p-4 shadow-[0_24px_60px_-20px_rgba(20,26,77,0.55)] backdrop-blur">
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
              <span className="rounded-full bg-[#F7F4EC] px-3 py-1.5 text-xs font-semibold text-[#1B2160]">
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
            <SendHorizonal size={16} strokeWidth={2} className="text-[#1B2160]" aria-hidden />
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
      <div className="relative overflow-hidden rounded-3xl border border-[#E4E7EE] bg-gradient-to-br from-[#E7F6EC] to-[#F7F5F0] p-6 sm:p-8">
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
            <p className="text-xs font-semibold uppercase tracking-wide text-[#8B95A9]">Near you</p>
            <p className="text-[10px] text-[#8B95A9]">Illustrative</p>
          </div>
          <ul className="mt-3 flex flex-col gap-2.5">
            {[
              { color: '#B26B1F', label: 'Storytime · Sat 10:30' },
              { color: '#1F8A4C', label: 'Toddler swim · Sun 9:00' },
              { color: '#3B5BDB', label: 'Nature walk · Sat 2:00' },
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
