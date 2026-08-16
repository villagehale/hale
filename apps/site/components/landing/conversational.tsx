import Image from 'next/image';
import shore from '~/assets/hale-shore-night.webp';
import { EmailCta } from '~/components/email-cta';
import { HeroConversation } from '~/components/landing/v3/hero-conversation';
import { LandingCta } from '~/components/landing-cta';
import { LogoMark } from '~/components/logo-mark';
import { SiteFooter } from '~/components/site-footer';
import { SiteHeader } from '~/components/site-header';
import { type ImpactNumber, impactNumbers } from '~/lib/landing/impact';
import { siteJsonLd } from '~/lib/site/structured-data';
import { CONTACT_EMAIL, buildSmsHref } from '~/lib/text-entry';

/**
 * villagehale.com — the landing.
 *
 * The layout it replaced opened with a column of copy beside a card of
 * conversation: a shape that says "here is a product that texts" while looking
 * like every other AI landing page. This one deletes the split. There is one
 * centred column, and the first thing in it is Hale typing the message a real
 * stranger receives, with the questions parents actually send sitting underneath
 * where a keyboard's suggestion strip would be. The hero is not a picture of the
 * product; it is the product's first turn.
 *
 * Two consequences worth naming:
 *   · The number's digits never appear. `sms:` links carry it invisibly and the
 *     laptop path is a copy button (components/copy-number.tsx) — a public
 *     number printed in the DOM gets scraped, and scraped numbers get the
 *     traffic Hale exists to keep out of a parent's thread.
 *   · The mark in the header is the flat white-on-navy turtle tile, and the page
 *     closes on the same tile beside the wordmark. No mascot art anywhere.
 *
 * Every claim below the hero survived the redesign word for word: the fifteen
 * named municipalities, the radar, the ladder, the coaching boundary, the
 * privacy register, the JSON-LD graph. app/landing.test.ts is the gate on that.
 */

/** The hero's CTA block — where the header's laptop CTA scrolls a reader to.
 * `scroll-padding-top` in globals.css clears the sticky bar. */
const CTA_ANCHOR = 'start';

/** The municipalities the radar tracks by name — every one backed by verified
 * registration_windows rows in prod (M1 + the 2026-08-11 coverage sweep). A city
 * joins this list when its rows land, never before. */
const MUNICIPALITIES = [
  'Toronto',
  'Mississauga',
  'Brampton',
  'Markham',
  'Vaughan',
  'Richmond Hill',
  'Oakville',
  'Burlington',
  'Halton Hills',
  'Caledon',
  'Ajax',
  'Pickering',
  'Whitby',
  'Oshawa',
  'Aurora',
] as const;

/** The four things the radar actually tracks — one per `ProgramDomain` in the
 * seeded windows, plus the waitlist clock those rows carry. Every claim here is
 * readable off registration-windows-data.ts; nothing is aspirational. */
const WATCHED = [
  {
    title: 'Swim lessons',
    body: 'The sessions that fill in minutes — and the towns that register them on a date of their own, weeks after everything else.',
  },
  {
    title: 'Camps',
    body: 'Fall programs, and the winter-break camps that quietly open for registration back in August.',
  },
  {
    title: 'After-school care',
    body: 'Where a city books it apart from the rest, on its own morning.',
  },
  {
    title: 'Waitlist clocks',
    body: 'Some towns give you a day to accept a spot, some two. I watch the clock either way.',
  },
] as const;

const THREE_TEXTS = [
  { step: 'You say hi.', body: 'One text to my number. No app, no account, no form to fill in.' },
  {
    step: 'I send your family’s radar.',
    body: 'Names and ages, a postal code — then the week that actually matters near you.',
  },
  {
    step: 'I keep watch.',
    body: 'A brief on Monday morning. A heads-up the week a registration opens, the plan the evening before, and a nudge as it goes live. Quiet in between.',
  },
] as const;

/** The coaching arc, which is a real sequence separated by days — the answer, the
 * plan a YES delivers, and the check-in Hale schedules for itself three days on. */
const COACHING = [
  {
    step: 'You ask.',
    body: 'An answer in two sentences, pitched at how old your child actually is — what’s common right now, and the thing to try tonight.',
  },
  {
    step: 'I offer the whole plan.',
    body: 'Say yes and it arrives as two or three texts — the real method by name, whether that’s Ferber’s check-in tables, the three-day potty protocol, or Health Canada’s allergen introduction. Minutes and counts, not principles.',
  },
  {
    step: 'A few days later, I ask how it went.',
    body: 'I name the day in the plan and set that reminder myself, so remembering to report back was never your job.',
  },
] as const;

const LADDER = [
  { rung: 'I suggest', body: 'the thing worth knowing this week, and why it matters now.' },
  { rung: 'I prepare', body: 'the shortlist, the links, the times — ready before the window opens.' },
  { rung: 'with your ok, I handle it', body: '— nothing reaches the outside world until you say so.' },
] as const;

export function ConversationalLanding({ smsNumber }: { smsNumber: string }) {
  // The bare-greeting composer link, for the closing band. The hero builds its
  // own from whichever question the reader picked, and the header resolves the
  // same door through chromeCta().
  const smsHref = smsNumber ? buildSmsHref(smsNumber, null) : null;
  const impact = impactNumbers();

  return (
    <main id="main" tabIndex={-1}>
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: JSON-LD is a serialized in-repo data object (no user input) — the standard way to emit SEO structured data.
        dangerouslySetInnerHTML={{ __html: JSON.stringify(siteJsonLd()) }}
      />

      {/* The same bar every subpage carries. `sms:` is a silent no-op on a laptop,
          so the desktop pill is handed the hero's CTA block to scroll to instead. */}
      <SiteHeader scrollTargetId={CTA_ANCHOR} />

      {/* ── Hero — one column, and Hale takes the first turn ───────────────── */}
      <section className="v3-bloom shell pb-20 pt-12 sm:pt-16 lg:pb-28 lg:pt-20">
        {/* The h1 stays for search and for the reader who needs the claim in one
            line, but it is deliberately small: the bubble under it is the hero. */}
        <h1 className="v3-thread mb-8 text-balance text-center text-[clamp(1.15rem,3.2vw,1.6rem)] font-semibold leading-snug">
          Hale is a number you text — your family’s{' '}
          <span className="v3-accent">quiet chief of staff.</span>
        </h1>

        <HeroConversation smsNumber={smsNumber} />
      </section>

      {/* ── What I watch — the radar, by name ─────────────────────────────── */}
      <section className="band-cream py-20 lg:py-28">
        <div className="shell">
          <span className="eyebrow">What I watch</span>
          <h2 className="mt-3 max-w-2xl text-balance">
            {MUNICIPALITIES.length} municipalities, <span className="v3-accent">by name.</span>
          </h2>
          <p className="mt-6 max-w-2xl text-lg text-slate-green" style={{ lineHeight: 1.6 }}>
            Registration opens at 7 a.m. on a Tuesday and fills before breakfast. I follow the
            calendars where you live, so nobody has to keep a tab open.
          </p>

          <ul className="mt-8 flex flex-wrap gap-2.5">
            {MUNICIPALITIES.map((city) => (
              <li key={city} className="pill pill-apricot">
                {city}
              </li>
            ))}
          </ul>

          <ul className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {WATCHED.map((item) => (
              <li key={item.title} className="v3-edge-card">
                <h3 className="text-[1.05rem] leading-snug">{item.title}</h3>
                <p className="meta mt-3">{item.body}</p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* ── How I work — three texts, then the ladder ─────────────────────── */}
      <section className="shell py-20 lg:py-28">
        <span className="eyebrow">How I work</span>
        <h2 className="mt-3 max-w-2xl text-balance">
          Three texts, then I’m <span className="v3-accent">quiet.</span>
        </h2>

        <ol className="mt-10 grid gap-8 lg:grid-cols-3">
          {THREE_TEXTS.map((item, i) => (
            <li key={item.step}>
              <span className="font-mono text-sm text-faded-sage">0{i + 1}</span>
              <h3 className="mt-2 text-[1.15rem] leading-snug">{item.step}</h3>
              <p className="mt-3 text-slate-green" style={{ lineHeight: 1.6 }}>
                {item.body}
              </p>
            </li>
          ))}
        </ol>

        <div className="panel-apricot-tint mt-14 p-8 sm:p-10">
          <p className="eyebrow">And when something needs doing</p>
          <ul className="mt-5 flex flex-col gap-4">
            {LADDER.map((item) => (
              <li key={item.rung} className="text-lg text-spruce" style={{ lineHeight: 1.5 }}>
                <strong className="font-semibold">{item.rung}</strong>{' '}
                <span className="text-slate-green">{item.body}</span>
              </li>
            ))}
          </ul>
          {/* The second sentence's phone half depends on claim-by-phone shipping first —
              see the merge-order note in app/landing.test.ts. A texted family has no
              email address, so "sign in" was untrue for them until that flow exists. */}
          <p className="mt-6 text-slate-green" style={{ lineHeight: 1.6 }}>
            Receipts for everything: every message names exactly what I did. Say yes to a date and
            it arrives as a calendar invite — a real event, at whatever address you give me. The
            full record — who, what, when — is yours any time: ask me in the thread, or sign in with
            your phone number.
          </p>
        </div>
      </section>

      {/* ── Coaching — the questions that aren't scheduling ────────────────── */}
      <section className="band-cream py-20 lg:py-28">
        <div className="shell">
          <span className="eyebrow">When you ask me something</span>
          <h2 className="mt-3 max-w-2xl text-balance">
            Sleep, solids, potty — <span className="v3-accent">answered, then planned.</span>
          </h2>
          <p className="mt-6 max-w-2xl text-lg text-slate-green" style={{ lineHeight: 1.6 }}>
            A chief of staff who only moved appointments would be a calendar. Ask me the 3 a.m.
            question and you get a real answer in the same thread — never a link telling you to go
            read someone else’s.
          </p>

          <ol className="mt-10 grid gap-8 lg:grid-cols-3">
            {COACHING.map((item, i) => (
              <li key={item.step}>
                <span className="font-mono text-sm text-faded-sage">0{i + 1}</span>
                <h3 className="mt-2 text-[1.15rem] leading-snug">{item.step}</h3>
                <p className="mt-3 text-slate-green" style={{ lineHeight: 1.6 }}>
                  {item.body}
                </p>
              </li>
            ))}
          </ol>

          <div className="mt-12 grid gap-6 lg:grid-cols-2">
            <div className="v3-edge-card">
              <h3 className="text-[1.15rem] leading-snug">What I’ll plan with you</h3>
              <p className="mt-3 text-slate-green" style={{ lineHeight: 1.6 }}>
                Sleep, starting solids, potty training, picky eating, tantrums, screen time, and the
                routines that hold a week together.
              </p>
            </div>
            <div className="v3-edge-card">
              <h3 className="text-[1.15rem] leading-snug">Where I stop</h3>
              <p className="mt-3 text-slate-green" style={{ lineHeight: 1.6 }}>
                I don’t diagnose and I never name a dose. A plan says what’s common and what
                families try, and it names the one situation worth raising with your doctor.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ── The caregivers, scoped ────────────────────────────────────────── */}
      <section className="shell py-20 lg:py-28">
        <span className="eyebrow">Your helpers</span>
        <h2 className="mt-3 max-w-2xl text-balance">
          Your helpers, <span className="v3-accent">only what they need.</span>
        </h2>

        <div className="mt-10 grid gap-6 lg:grid-cols-2">
          <div className="v3-edge-card">
            <h3 className="text-[1.15rem] leading-snug">Grandparents and the nanny</h3>
            <p className="mt-3 text-slate-green" style={{ lineHeight: 1.6 }}>
              They get just the schedule — who’s where, and when to be there. Nothing else about
              your family travels with it, and everyone opts in for themselves.
            </p>
          </div>
          <div className="v3-edge-card">
            <h3 className="text-[1.15rem] leading-snug">Your co-parent</h3>
            <p className="mt-3 text-slate-green" style={{ lineHeight: 1.6 }}>
              Always free. The same radar and the same reminders, on their own number — never a
              second household to pay for.
            </p>
          </div>
        </div>
      </section>

      {/* ── Privacy, the Canadian way ─────────────────────────────────────── */}
      <section className="band-cream py-20 lg:py-28">
        <div className="shell">
          <span className="eyebrow">Privacy</span>
          <h2 className="mt-3 max-w-2xl text-balance">
            Privacy, the <span className="v3-accent">Canadian way.</span>
          </h2>
          <div className="mt-6 max-w-2xl text-lg text-slate-green" style={{ lineHeight: 1.6 }}>
            <p>
              Your family’s data stays in Canada. Every permission is granular, auditable, and
              revocable — you grant it in a text and withdraw it in a text. A child’s information is
              sensitive by default, and a teenager’s more so.
            </p>
            <p className="mt-5">
              Texting is not private the way a sealed app is: a message crosses your carrier and my
              messaging provider before it reaches you. So I write to that reality — I name the
              task, never the diagnosis.{' '}
              <a href="/privacy" className="link">
                How I handle your data
              </a>
              .
            </p>
          </div>
        </div>
      </section>

      {/* ── Impact numbers — rendered only once the counts are real ───────── */}
      {impact && <ImpactBand numbers={impact} />}

      {/* ── Founding families — the shore, and the brand lockup ───────────── *
       * Hale is Hawaiian for home and the mark is a honu, so the page closes on
       * the shoreline the name comes from rather than on a flat band. One image,
       * one placement, decorative: the argument is still entirely in the words. */}
      <section className="px-4 pb-16 sm:px-6 lg:pb-24">
        <div className="v3-shore-band mx-auto max-w-[1100px] rounded-[28px]">
          <div className="v3-shore-copy px-6 pb-12 pt-14 text-center sm:px-12 lg:ml-auto lg:max-w-[30rem] lg:py-24 lg:text-left">
            <span className="inline-flex items-center gap-3">
              <LogoMark size={44} className="v3-logo-tile" />
              <span className="font-serif text-[1.6rem] font-semibold leading-none">Hale</span>
            </span>
            <h2 className="mt-6 text-[clamp(1.8rem,3.4vw,2.6rem)]">Founding families</h2>
            <p className="v3-shore-sub mt-5 text-lg" style={{ lineHeight: 1.6 }}>
              I’m free while I’m new, and the families who start now keep their founding rate for
              good. No countdown, no waiting list — just the number.
            </p>
            {smsHref ? (
              <div className="mt-9 flex justify-center lg:justify-start">
                <LandingCta event="landing_cta_text" href={smsHref} className="v3-btn-shore">
                  Text me
                </LandingCta>
              </div>
            ) : (
              <div className="mt-9 flex justify-center lg:justify-start">
                <EmailCta
                  email={CONTACT_EMAIL}
                  buttonClassName="v3-btn-shore"
                  copyClassName="v3-btn-shore"
                />
              </div>
            )}
          </div>
          {/* After the copy in the DOM as well as under it on screen: decorative
              art belongs behind the words in reading order too. */}
          <div className="v3-shore-frame">
            <Image
              src={shore}
              alt=""
              aria-hidden="true"
              fill
              sizes="(max-width: 1148px) 100vw, 1100px"
              className="v3-shore-art"
            />
          </div>
        </div>
      </section>

      <p className="shell meta pb-20 text-center">
        More questions?{' '}
        <a href="/faq" className="link">
          The answers parents ask for most
        </a>
        .
      </p>

      <SiteFooter />
    </main>
  );
}

/**
 * The metrics band. Never rendered with placeholder zeros — the caller only
 * reaches it once `impactNumbers()` returns real counts.
 */
function ImpactBand({ numbers }: { numbers: readonly ImpactNumber[] }) {
  return (
    <section className="py-16 lg:py-20">
      <ul className="shell grid gap-10 text-center sm:grid-cols-3">
        {numbers.map((n) => (
          <li key={n.label}>
            <p className="font-display text-[clamp(2.2rem,4vw,3rem)] font-semibold text-spruce">
              {n.value}
            </p>
            <p className="meta mt-2">{n.label}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
