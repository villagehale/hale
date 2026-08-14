import { EmailCta } from '~/components/email-cta';
import { LandingCta } from '~/components/landing-cta';
import { QrCode } from '~/components/qr-code';
import { APP_URL } from '~/lib/app-url';
import { type ImpactNumber, impactNumbers } from '~/lib/landing/impact';
import { siteJsonLd } from '~/lib/site/structured-data';
import { CONTACT_EMAIL, buildSmsHref, displaySmsNumber } from '~/lib/text-entry';

/**
 * villagehale.com under NEXT_PUBLIC_F14_LANDING (VIL-250 · M14) — the landing
 * repositioned around the persona (D20): Hale is the family's quiet chief of
 * staff, and the number is how you reach it, never what it is.
 *
 * Two rules shape everything below:
 *   · The only way in is texting Hale. There is no signup funnel — one quiet
 *     "Sign in" text link in the header and one in the footer, for the families
 *     who already have a receipts room (and for PIPEDA access rights).
 *   · Nothing claims a capability that isn't live. The impact band renders only
 *     once real counts exist, the thread is labelled an example, and with no
 *     number provisioned the page offers email rather than a dead sms: link.
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

export function ChiefOfStaffLanding({ smsNumber }: { smsNumber: string }) {
  const smsHref = smsNumber ? buildSmsHref(smsNumber, null) : null;
  const impact = impactNumbers();

  return (
    <main id="main" tabIndex={-1}>
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: JSON-LD is a serialized in-repo data object (no user input) — the standard way to emit SEO structured data.
        dangerouslySetInnerHTML={{ __html: JSON.stringify(siteJsonLd()) }}
      />

      {/* Sticky, not fixed: the bar keeps its space in the flow, so nothing under it
          jumps. The page's only two CTAs sat ~5 viewports apart, so the way in has to
          travel with the reader. With no number provisioned there is nothing to offer
          here — the header stays the quiet Sign in link it has always been. */}
      <header className="sticky top-0 z-50 border-b border-rule bg-linen/85 backdrop-blur-md">
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
      <section className="shell grid items-center gap-12 pb-20 pt-8 sm:pt-12 lg:grid-cols-[1.05fr_0.95fr] lg:gap-16 lg:pb-28">
        <div className="rise rise-1 max-w-xl">
          <h1 className="text-balance text-[clamp(2.1rem,5.2vw,3.4rem)]">
            Hi, I’m Hale — your family’s quiet chief of staff.
          </h1>
          <p className="mt-6 text-lg text-slate-green" style={{ lineHeight: 1.6 }}>
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
                <QrCode value={smsHref} size={132} />
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

        <FirstConversation />
      </section>

      {/* ── What I watch — the radar, by name ─────────────────────────────── */}
      <section className="band-cream py-20 lg:py-28">
        <div className="shell">
          <span className="eyebrow">What I watch</span>
          <h2 className="mt-3 max-w-2xl text-balance">
            {MUNICIPALITIES.length} municipalities, <span className="accent">by name.</span>
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
              <li key={item.title} className="card">
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
          Three texts, then I’m <span className="accent">quiet.</span>
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
              see the merge-order note in landing-f14.test.ts. A texted family has no
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
            Sleep, solids, potty — <span className="accent">answered, then planned.</span>
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
            <div className="card">
              <h3 className="text-[1.15rem] leading-snug">What I’ll plan with you</h3>
              <p className="mt-3 text-slate-green" style={{ lineHeight: 1.6 }}>
                Sleep, starting solids, potty training, picky eating, tantrums, screen time, and the
                routines that hold a week together.
              </p>
            </div>
            <div className="card">
              <h3 className="text-[1.15rem] leading-snug">Where I stop</h3>
              <p className="mt-3 text-slate-green" style={{ lineHeight: 1.6 }}>
                I don’t diagnose and I never name a dose. A plan says what’s common and what
                families try, and it names the one situation worth raising with your doctor.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ── The caregivers, scoped ────────────────────────────────────────── *
       * "Village" is the family-to-family intros product; the people below are
       * scoped caregivers on this family's own account, which is a different
       * thing and was borrowing the wrong word. */}
      <section className="shell py-20 lg:py-28">
        <span className="eyebrow">Your helpers</span>
        <h2 className="mt-3 max-w-2xl text-balance">
          Your helpers, <span className="accent">only what they need.</span>
        </h2>

        <div className="mt-10 grid gap-6 lg:grid-cols-2">
          <div className="card">
            <h3 className="text-[1.15rem] leading-snug">Grandparents and the nanny</h3>
            <p className="mt-3 text-slate-green" style={{ lineHeight: 1.6 }}>
              They get just the schedule — who’s where, and when to be there. Nothing else about
              your family travels with it, and everyone opts in for themselves.
            </p>
          </div>
          <div className="card">
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
            Privacy, the <span className="accent">Canadian way.</span>
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

      {/* ── Founding families ─────────────────────────────────────────────── */}
      <section className="px-4 pb-16 sm:px-6 lg:pb-24">
        <div className="cta-band mx-auto max-w-[1100px] rounded-[28px] px-6 py-14 text-center sm:px-12 md:py-20">
          <h2 className="mx-auto max-w-2xl text-[clamp(1.8rem,3.4vw,2.6rem)]">Founding families</h2>
          <p className="cta-sub mx-auto mt-5 max-w-xl text-lg" style={{ lineHeight: 1.6 }}>
            I’m free while I’m new, and the families who start now keep their founding rate for
            good. No countdown, no waiting list — just the number.
          </p>
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
 * the teaser a bubble to say so twice.) Real DOM text in a
 * plain card: no device frame, no status bar, nothing pretending to be a photo
 * of a phone. Emoji-free on purpose: the real transport is GSM-7 and Hale sends
 * none. (The em dashes and curly quotes here are the site's typographic render
 * of the plain-ASCII originals in intake/copy.ts — WORDS match the script
 * exactly; punctuation is display-layer.)
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
