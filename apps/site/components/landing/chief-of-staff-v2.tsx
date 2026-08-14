import Image from 'next/image';
import turtleCelebrate from '~/assets/hale-turtle-celebrate-alpha.png';
import turtleWave from '~/assets/hale-turtle-wave-alpha.png';
import { EmailCta } from '~/components/email-cta';
import { Reveal } from '~/components/landing/v2/reveal';
import { RotatingThread } from '~/components/landing/v2/rotating-thread';
import { LandingCta } from '~/components/landing-cta';
import { QrCode } from '~/components/qr-code';
import { APP_URL } from '~/lib/app-url';
import { type ImpactNumber, impactNumbers } from '~/lib/landing/impact';
import { siteJsonLd } from '~/lib/site/structured-data';
import { CONTACT_EMAIL, buildSmsHref, displaySmsNumber } from '~/lib/text-entry';

/**
 * Landing v2 — the candidate homepage, served only at /preview/landing-v2 while
 * the founder decides. `chief-of-staff.tsx` is the live page and this file must
 * not touch it: the copy below is a deliberate parallel copy, not an extraction,
 * so a change here can never reach villagehale.com by accident. If v2 wins, the
 * merge is a one-line swap in app/page.tsx and this file replaces that one.
 *
 * What changes from v1, and why:
 *   · Every claim, every sentence and every conversion fix from v1 survives
 *     word for word — the `sms:` CTA with the dialable number in the first
 *     viewport at all widths, the sticky header, the three-bubble teaser, the
 *     fifteen named municipalities, the privacy register, the JSON-LD.
 *   · One new surface: a navy band under the hero carrying a frosted card that
 *     cycles three real exchanges. It is the page's proof that Hale answers, and
 *     the only loud thing on it.
 *   · Motion: headings blur-and-rise, paragraphs follow, art wipes up, section
 *     hairlines draw themselves. All CSS, all disabled under reduced motion.
 *   · The h1 finally gets the serif accent every other heading has, on the words
 *     that are the whole positioning. No copy changed to get it.
 *   · The turtle is back — waving beside the conversation, cheering at the close.
 */

const SIGN_IN = `${APP_URL}/sign-in`;

/** The hero's CTA block — the one place on the page that carries both the composer
 * link and the number as readable text, and so the target the header CTA scrolls a
 * laptop reader to. `scroll-padding-top` in globals.css clears the sticky bar. */
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

export function ChiefOfStaffLandingV2({ smsNumber }: { smsNumber: string }) {
  const smsHref = smsNumber ? buildSmsHref(smsNumber, null) : null;
  const impact = impactNumbers();

  return (
    // `v2-theme` is the whole dark-mode mechanism: the class re-points the design
    // system's custom properties under prefers-color-scheme: dark, for this
    // subtree only, so v1 and every subpage stay light-only until v2 is chosen.
    <main id="main" tabIndex={-1} className="v2-theme">
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: JSON-LD is a serialized in-repo data object (no user input) — the standard way to emit SEO structured data.
        dangerouslySetInnerHTML={{ __html: JSON.stringify(siteJsonLd()) }}
      />

      {/* Sticky, not fixed: the bar keeps its space in the flow, so nothing under it
          jumps. The page's only two CTAs sat ~5 viewports apart, so the way in has to
          travel with the reader. With no number provisioned there is nothing to offer
          here — the header stays the quiet Sign in link it has always been. */}
      {/* /92 rather than v1's /85: v2 has a full-bleed dark band under the hero,
          and at 85% the bar picked up enough of it to read as a grey smear. */}
      <header className="sticky top-0 z-50 border-b border-rule bg-linen/92 backdrop-blur-md">
        <div className="shell flex items-center justify-between py-3">
          <a href="/" className="font-serif text-[1.35rem] font-semibold leading-none text-spruce">
            Hale
          </a>
          <div className="flex items-center gap-3">
            <a
              href={SIGN_IN}
              className="py-1 text-sm font-medium text-slate-green hover:text-spruce"
            >
              Sign in
            </a>
            {smsHref && (
              <>
                {/* One action, split by where it actually works — the same reason the QR
                    card below is desktop-only. On a phone the composer opens; on a laptop
                    `sms:` is a silent no-op, so the button carries the reader to the hero
                    number instead of appearing to do nothing. */}
                <LandingCta
                  event="landing_cta_text"
                  href={smsHref}
                  className="btn-primary btn-compact min-h-11 sm:hidden"
                >
                  Text Hale
                </LandingCta>
                <a
                  href={`#${CTA_ANCHOR}`}
                  className="btn-primary btn-compact hidden min-h-11 sm:inline-flex"
                >
                  Text Hale
                </a>
              </>
            )}
          </div>
        </div>
      </header>

      {/* ── Hero — the persona, the one action, and the real thread ────────── */}
      <section className="shell grid items-center gap-14 pb-24 pt-10 sm:pt-14 lg:grid-cols-[1.05fr_0.95fr] lg:gap-16 lg:pb-32">
        <div className="rise rise-1 max-w-xl">
          {/* The display scale a first line this important deserves, and the serif
              accent the rest of the page's headings have always had — landing on the
              four words that are the entire positioning. Same sentence as v1. */}
          <h1 className="text-balance text-[clamp(2.4rem,6vw,4.1rem)] leading-[1.03]">
            Hi, I’m Hale — your family’s <span className="v2-accent">quiet chief of staff.</span>
          </h1>
          <p className="mt-7 text-[1.15rem] text-slate-green" style={{ lineHeight: 1.6 }}>
            I keep watch over your week — registrations, programs, checkups, weather — and text you
            before things matter.
          </p>

          {smsHref ? (
            <div id={CTA_ANCHOR} className="mt-9">
              <LandingCta event="landing_cta_text" href={smsHref} className="btn-primary">
                Text me
              </LandingCta>
              {/* The number as readable text, under the button on every viewport. An
                  `sms:` link is a silent no-op on Windows and Linux, and the QR card
                  below is desktop-only, so a Windows reader had nothing to dial and a
                  phone reader never saw the number at all. */}
              <p className="mt-4 text-slate-green">
                or text{' '}
                <a href={smsHref} className="link font-mono">
                  {displaySmsNumber(smsNumber)}
                </a>
              </p>
              <p className="meta mt-4">
                Your message is already written. You send it; I never text first. Standard message
                rates apply; reply STOP any time.
              </p>

              {/* Desktop-only: a phone can't scan its own screen, and on mobile this card
                  only pushed the example conversation below the fold. */}
              <div className="card mt-8 hidden gap-6 sm:flex sm:items-center">
                <div className="v2-qr-plate shrink-0">
                  <QrCode value={smsHref} size={132} />
                </div>
                <div>
                  <span className="eyebrow">On a laptop?</span>
                  <p className="mt-2 font-mono text-lg text-spruce">
                    {displaySmsNumber(smsNumber)}
                  </p>
                  <p className="meta mt-2">
                    Scan the code with your phone’s camera, or text that number yourself.
                  </p>
                </div>
              </div>
            </div>
          ) : (
            <div className="mt-9">
              <EmailCta email={CONTACT_EMAIL} buttonClassName="btn-primary" />
              <p className="meta mt-4">
                The number’s coming. Until it answers, email is the honest way to reach me.
              </p>
            </div>
          )}
        </div>

        <div className="relative">
          {/* Hale, waving at the reader from the corner of its own conversation. The
              mascot carries no meaning a screen reader needs — the thread beside it
              says everything — so it is decorative and named as such.
              In flow on a phone (overlapping the card there put the turtle straight
              through the "An example conversation" label); floating over the card's
              top-right corner from lg up, where the label ends far to its left. */}
          <Reveal
            variant="mask"
            className="pointer-events-none mb-3 ml-auto w-24 lg:absolute lg:-top-16 lg:right-4 lg:z-10 lg:mb-0 lg:w-32"
          >
            <Image
              src={turtleWave}
              alt=""
              aria-hidden="true"
              width={1254}
              height={1254}
              sizes="(max-width: 1024px) 96px, 128px"
              className="v2-mascot h-auto w-full"
            />
          </Reveal>
          <FirstConversation />
        </div>
      </section>

      <div className="shell">
        <Reveal variant="rule" />
      </div>

      {/* ── The alive proof — three real exchanges, on the one dark surface ── *
       * The hero's thread is the script Hale opens with; this is what the rest of
       * the relationship sounds like. Navy because a frosted card needs something
       * to frost against, and because the page has earned one loud beat by here. */}
      <section className="v2-band-navy py-24 lg:py-32">
        <div className="shell grid gap-12 lg:grid-cols-[0.9fr_1.1fr] lg:items-center lg:gap-20">
          <div>
            <Reveal>
              <span className="eyebrow v2-stage-soft">Then you just talk to me</span>
              <h2 className="mt-3 text-balance">
                Ask me anything a <span className="v2-accent">parent asks.</span>
              </h2>
            </Reveal>
            <Reveal variant="text" as="p" className="v2-stage-soft mt-6 text-lg">
              No keywords, no menus. You write the way you’d text a friend who happens to know when
              registration opens and what the research says about solids.
            </Reveal>
            <Reveal variant="text" as="p" className="meta v2-stage-faint mt-6">
              These are the replies I’m built to send — the script I follow and the sourced plans
              behind it. Your names, your town, your dates.
            </Reveal>
          </div>

          <RotatingThread />
        </div>
      </section>

      {/* ── What I watch — the radar, by name ─────────────────────────────── */}
      <section className="band-cream py-24 lg:py-32">
        <div className="shell">
          <Reveal>
            <span className="eyebrow">What I watch</span>
            <h2 className="mt-3 max-w-2xl text-balance">
              {MUNICIPALITIES.length} municipalities, <span className="v2-accent">by name.</span>
            </h2>
          </Reveal>
          <Reveal
            variant="text"
            as="p"
            className="mt-6 max-w-2xl text-lg text-slate-green"
          >
            Registration opens at 7 a.m. on a Tuesday and fills before breakfast. I follow the
            calendars where you live, so nobody has to keep a tab open.
          </Reveal>

          <Reveal variant="text" as="ul" className="mt-8 flex flex-wrap gap-2.5">
            {MUNICIPALITIES.map((city) => (
              <li key={city} className="pill pill-apricot">
                {city}
              </li>
            ))}
          </Reveal>

          <ul className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {WATCHED.map((item) => (
              <Reveal key={item.title} variant="text" as="li" className="v2-edge-card">
                <h3 className="text-[1.05rem] leading-snug">{item.title}</h3>
                <p className="meta mt-3">{item.body}</p>
              </Reveal>
            ))}
          </ul>
        </div>
      </section>

      {/* ── How I work — three texts, then the ladder ─────────────────────── */}
      <section className="shell py-24 lg:py-32">
        <Reveal>
          <span className="eyebrow">How I work</span>
          <h2 className="mt-3 max-w-2xl text-balance">
            Three texts, then I’m <span className="v2-accent">quiet.</span>
          </h2>
        </Reveal>

        <ol className="mt-10 grid gap-8 lg:grid-cols-3">
          {THREE_TEXTS.map((item, i) => (
            <Reveal key={item.step} variant="text" as="li">
              <span className="font-mono text-sm text-faded-sage">0{i + 1}</span>
              <h3 className="mt-2 text-[1.15rem] leading-snug">{item.step}</h3>
              <p className="mt-3 text-slate-green" style={{ lineHeight: 1.6 }}>
                {item.body}
              </p>
            </Reveal>
          ))}
        </ol>

        <Reveal variant="text" className="panel-apricot-tint mt-14 p-8 sm:p-10">
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
              see the merge-order note in landing-f14.test.ts. A texted family has no
              email address, so "sign in" was untrue for them until that flow exists. */}
          <p className="mt-6 text-slate-green" style={{ lineHeight: 1.6 }}>
            Receipts for everything: every message names exactly what I did. Say yes to a date and
            it arrives as a calendar invite — a real event, at whatever address you give me. The
            full record — who, what, when — is yours any time: ask me in the thread, or sign in with
            your phone number.
          </p>
        </Reveal>
      </section>

      <div className="shell">
        <Reveal variant="rule" />
      </div>

      {/* ── Coaching — the questions that aren't scheduling ────────────────── */}
      <section className="band-cream py-24 lg:py-32">
        <div className="shell">
          <Reveal>
            <span className="eyebrow">When you ask me something</span>
            <h2 className="mt-3 max-w-2xl text-balance">
              Sleep, solids, potty — <span className="v2-accent">answered, then planned.</span>
            </h2>
          </Reveal>
          <Reveal variant="text" as="p" className="mt-6 max-w-2xl text-lg text-slate-green">
            A chief of staff who only moved appointments would be a calendar. Ask me the 3 a.m.
            question and you get a real answer in the same thread — never a link telling you to go
            read someone else’s.
          </Reveal>

          <ol className="mt-10 grid gap-8 lg:grid-cols-3">
            {COACHING.map((item, i) => (
              <Reveal key={item.step} variant="text" as="li">
                <span className="font-mono text-sm text-faded-sage">0{i + 1}</span>
                <h3 className="mt-2 text-[1.15rem] leading-snug">{item.step}</h3>
                <p className="mt-3 text-slate-green" style={{ lineHeight: 1.6 }}>
                  {item.body}
                </p>
              </Reveal>
            ))}
          </ol>

          <div className="mt-12 grid gap-6 lg:grid-cols-2">
            <Reveal variant="text" className="v2-edge-card">
              <h3 className="text-[1.15rem] leading-snug">What I’ll plan with you</h3>
              <p className="mt-3 text-slate-green" style={{ lineHeight: 1.6 }}>
                Sleep, starting solids, potty training, picky eating, tantrums, screen time, and the
                routines that hold a week together.
              </p>
            </Reveal>
            <Reveal variant="text" className="v2-edge-card">
              <h3 className="text-[1.15rem] leading-snug">Where I stop</h3>
              <p className="mt-3 text-slate-green" style={{ lineHeight: 1.6 }}>
                I don’t diagnose and I never name a dose. A plan says what’s common and what
                families try, and it names the one situation worth raising with your doctor.
              </p>
            </Reveal>
          </div>
        </div>
      </section>

      {/* ── The caregivers, scoped ────────────────────────────────────────── *
       * "Village" is the family-to-family intros product; the people below are
       * scoped caregivers on this family's own account, which is a different
       * thing and was borrowing the wrong word. */}
      <section className="shell py-24 lg:py-32">
        <Reveal>
          <span className="eyebrow">Your helpers</span>
          <h2 className="mt-3 max-w-2xl text-balance">
            Your helpers, <span className="v2-accent">only what they need.</span>
          </h2>
        </Reveal>

        <div className="mt-10 grid gap-6 lg:grid-cols-2">
          <Reveal variant="text" className="v2-edge-card">
            <h3 className="text-[1.15rem] leading-snug">Grandparents and the nanny</h3>
            <p className="mt-3 text-slate-green" style={{ lineHeight: 1.6 }}>
              They get just the schedule — who’s where, and when to be there. Nothing else about
              your family travels with it, and everyone opts in for themselves.
            </p>
          </Reveal>
          <Reveal variant="text" className="v2-edge-card">
            <h3 className="text-[1.15rem] leading-snug">Your co-parent</h3>
            <p className="mt-3 text-slate-green" style={{ lineHeight: 1.6 }}>
              Always free. The same radar and the same reminders, on their own number — never a
              second household to pay for.
            </p>
          </Reveal>
        </div>
      </section>

      {/* ── Privacy, the Canadian way ─────────────────────────────────────── */}
      <section className="band-cream py-24 lg:py-32">
        <div className="shell">
          <Reveal>
            <span className="eyebrow">Privacy</span>
            <h2 className="mt-3 max-w-2xl text-balance">
              Privacy, the <span className="v2-accent">Canadian way.</span>
            </h2>
          </Reveal>
          <Reveal
            variant="text"
            className="mt-6 max-w-2xl text-lg text-slate-green"
          >
            <p style={{ lineHeight: 1.6 }}>
              Your family’s data stays in Canada. Every permission is granular, auditable, and
              revocable — you grant it in a text and withdraw it in a text. A child’s information is
              sensitive by default, and a teenager’s more so.
            </p>
            <p className="mt-5" style={{ lineHeight: 1.6 }}>
              Texting is not private the way a sealed app is: a message crosses your carrier and my
              messaging provider before it reaches you. So I write to that reality — I name the
              task, never the diagnosis.{' '}
              <a href="/privacy" className="link">
                How I handle your data
              </a>
              .
            </p>
          </Reveal>
        </div>
      </section>

      {/* ── Impact numbers — rendered only once the counts are real ───────── */}
      {impact && <ImpactBand numbers={impact} />}

      {/* ── Founding families ─────────────────────────────────────────────── */}
      <section className="px-4 pb-20 pt-4 sm:px-6 lg:pb-28">
        <div className="cta-band mx-auto max-w-[1100px] rounded-[28px] px-6 py-14 text-center sm:px-12 md:py-20">
          <Reveal variant="mask" className="mx-auto w-28 lg:w-36">
            <Image
              src={turtleCelebrate}
              alt=""
              aria-hidden="true"
              width={1254}
              height={1254}
              sizes="(max-width: 1024px) 112px, 144px"
              className="v2-mascot h-auto w-full"
            />
          </Reveal>
          <Reveal className="mt-4">
            <h2 className="mx-auto max-w-2xl text-[clamp(1.9rem,3.6vw,2.8rem)]">
              Founding families
            </h2>
          </Reveal>
          <Reveal variant="text" as="p" className="cta-sub mx-auto mt-5 max-w-xl text-lg">
            I’m free while I’m new, and the families who start now keep their founding rate for
            good. No countdown, no waiting list — just the number.
          </Reveal>
          {smsHref ? (
            <div className="mt-9 flex justify-center">
              <LandingCta event="landing_cta_text" href={smsHref} className="btn-on-navy">
                Text me
              </LandingCta>
            </div>
          ) : (
            <div className="mt-9 flex justify-center">
              <EmailCta
                email={CONTACT_EMAIL}
                buttonClassName="btn-on-navy"
                copyClassName="btn-on-navy"
              />
            </div>
          )}
        </div>
      </section>

      <p className="shell meta pb-20 text-center">
        More questions?{' '}
        <a href="/faq" className="link">
          The answers parents ask for most
        </a>
        .
      </p>

      <footer className="border-t border-rule">
        <div className="shell flex flex-col gap-6 py-10 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <span className="font-serif text-[1.2rem] font-semibold leading-none text-spruce">
              Hale
            </span>
            <p className="meta mt-3">
              Village Hale Technologies Inc., Georgetown, Ontario. Your data stays in Canada.
            </p>
            <p className="meta mt-1">© {new Date().getFullYear()} Hale.</p>
          </div>
          <nav aria-label="Footer" className="flex flex-wrap gap-x-6 gap-y-1">
            {[
              { label: 'FAQ', href: '/faq' },
              { label: 'Privacy', href: '/privacy' },
              { label: 'Terms', href: '/terms' },
              { label: 'Contact', href: '/contact' },
              { label: 'Sign in', href: SIGN_IN },
            ].map((item) => (
              <a
                key={item.label}
                href={item.href}
                className="py-1 text-sm font-medium text-slate-green hover:text-spruce"
              >
                {item.label}
              </a>
            ))}
          </nav>
        </div>
      </footer>
    </main>
  );
}

/**
 * The first ten minutes, as an SMS thread — the script from the F14 Conversation
 * Design book, not a dramatisation and not a screenshot. (The parent's opening
 * "Hi" is the one line dropped: the CTA above already pre-writes it, and it cost
 * the teaser a bubble to say so twice.) Real DOM text in a plain card: no device
 * frame, no status bar, nothing pretending to be a photo of a phone. Emoji-free
 * on purpose: the real transport is GSM-7 and Hale sends none. (The em dashes and
 * curly quotes here are the site's typographic render of the plain-ASCII
 * originals in intake/copy.ts — WORDS match the script exactly; punctuation is
 * display-layer.)
 */
function FirstConversation() {
  return (
    <figure className="rise rise-2 card m-0">
      <figcaption>
        <span className="eyebrow">An example conversation</span>
        <p className="meta mt-2">
          This is the script I follow. The names, the dates and the places change with your family.
        </p>
      </figcaption>

      <ol className="mt-6 flex flex-col gap-3">
        <Bubble from="hale">
          Hi, I’m Hale — an AI that quietly runs the family week. Registration dates, weekend
          plans, the stuff that slips. Tell me your kids’ names and ages, plus your postal code —
          and I’ll get to work.
        </Bubble>
        <Bubble from="parent">Max is 4, Mia is 18 months, L4C</Bubble>
        <Bubble from="hale">
          Mark this: Richmond Hill fall swim registration opens Tue Aug 12 at 7am — spots for
          Max’s age go in minutes. You’ll have the plan the evening before, and a text right
          before it opens.
          Saturday looks warm too — the Mill Pond splash pad is 6 minutes from you, free. Want me
          to keep an eye on all of this for you?
          <span className="mt-2 block text-[0.8rem] opacity-70">
            (how I handle your family’s info: villagehale.com/privacy)
          </span>
        </Bubble>
      </ol>

      {/* The thread ran the full first ten minutes before a reader reached anything
          else on the page. The teaser above is the greeting, the family in one line
          and the catch; the rest of the script stays whole, one tap away, and stays
          in order. Native <details> — no JS, keyboard- and screen-reader-native. */}
      <details className="mt-4">
        <summary className="cursor-pointer py-3 text-sm font-medium text-slate-green hover:text-spruce">
          The rest of the thread
        </summary>
        <ol className="flex flex-col gap-3">
          <Bubble from="parent">yes please</Bubble>
          <Bubble from="hale">
            Done — you’re covered. I only text when something actually matters, and STOP always
            works. While I dig in: what part of the week wears you out the most?
          </Bubble>
        </ol>
      </details>
    </figure>
  );
}

function Bubble({ from, children }: { from: 'parent' | 'hale'; children: React.ReactNode }) {
  const parent = from === 'parent';
  return (
    <li className={parent ? 'flex justify-end' : 'flex justify-start'}>
      <p
        className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-[0.95rem] ${
          parent
            ? 'rounded-br-sm bg-spruce text-on-spruce'
            : 'rounded-bl-sm bg-sky-tint text-spruce'
        }`}
        style={{ lineHeight: 1.5 }}
      >
        <span className="sr-only">{parent ? 'Parent:' : 'Hale:'}</span>
        {children}
      </p>
    </li>
  );
}

/**
 * The Boardy-shaped metrics band. Never rendered with placeholder zeros — the
 * caller only reaches it once `impactNumbers()` returns real counts.
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
