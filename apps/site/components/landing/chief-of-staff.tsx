import { QrCode } from '~/components/qr-code';
import { APP_URL } from '~/lib/app-url';
import { type ImpactNumber, impactNumbers } from '~/lib/landing/impact';
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

/** The municipalities M1 tracks by name — the radar made concrete, not "the GTA". */
const MUNICIPALITIES = [
  'Toronto',
  'Markham',
  'Vaughan',
  'Richmond Hill',
  'Mississauga',
  'Oakville',
  'Burlington',
  'Halton Hills',
] as const;

const WATCHED = [
  { title: 'Camp registration', body: 'March break and summer, the morning the window opens.' },
  { title: 'Swim lessons', body: 'The sessions that fill in minutes, per municipality.' },
  { title: 'Waitlist clocks', body: 'The 36 hours you get to accept a spot before it moves on.' },
  { title: 'PA days and closures', body: 'The Thursday nobody remembers until Wednesday night.' },
] as const;

const THREE_TEXTS = [
  { step: 'You say hi.', body: 'One text to my number. No app, no account, no form to fill in.' },
  {
    step: 'I send your family’s radar.',
    body: 'Names and ages, a postal code — then the week that actually matters near you.',
  },
  {
    step: 'I keep watch.',
    body: 'After that I only text when something matters. Silence is the normal state.',
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
      <header className="shell flex items-center justify-between py-6">
        <a href="/" className="font-serif text-[1.35rem] font-semibold leading-none text-spruce">
          Hale
        </a>
        <a href={SIGN_IN} className="py-1 text-sm font-medium text-slate-green hover:text-spruce">
          Sign in
        </a>
      </header>

      {/* ── Hero — the persona, the one action, and the real thread ────────── */}
      <section className="shell grid items-center gap-12 pb-20 pt-8 sm:pt-12 lg:grid-cols-[1.05fr_0.95fr] lg:gap-16 lg:pb-28">
        <div className="rise rise-1 max-w-xl">
          <h1 className="text-[clamp(2.1rem,5.2vw,3.4rem)]">
            Hi, I’m Hale — your family’s quiet chief of staff.
          </h1>
          <p className="mt-6 text-lg text-slate-green" style={{ lineHeight: 1.6 }}>
            I keep watch over your week — registrations, programs, school paperwork, weather — and
            text you before things matter.
          </p>

          {smsHref ? (
            <div className="mt-9">
              <a href={smsHref} className="btn-primary">
                Text me
              </a>
              <p className="meta mt-4">
                Your message is already written. You send it; I never text first.
              </p>

              <div className="card mt-8 flex flex-col gap-6 sm:flex-row sm:items-center">
                <QrCode value={smsHref} size={132} />
                <div>
                  <span className="eyebrow">On a laptop?</span>
                  <p className="mt-2 font-mono text-lg text-spruce">
                    {displaySmsNumber(smsNumber)}
                  </p>
                  <p className="meta mt-2">
                    Scan the code with your phone’s camera, or text that number yourself. Standard
                    message rates apply; reply STOP any time.
                  </p>
                </div>
              </div>
            </div>
          ) : (
            <div className="mt-9">
              <a href={`mailto:${CONTACT_EMAIL}`} className="btn-primary">
                Email me
              </a>
              <p className="mt-4 font-mono text-spruce">{CONTACT_EMAIL}</p>
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
          <h2 className="mt-3 max-w-2xl">
            Eight municipalities, <span className="accent">by name.</span>
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
        <h2 className="mt-3 max-w-2xl">
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
          <p className="mt-6 text-slate-green" style={{ lineHeight: 1.6 }}>
            Receipts for everything: every message names exactly what I did, and the full record —
            who, what, when — waits in your account.
          </p>
        </div>
      </section>

      {/* ── Your village, covered ─────────────────────────────────────────── */}
      <section className="band-cream py-20 lg:py-28">
        <div className="shell">
          <span className="eyebrow">Your village</span>
          <h2 className="mt-3 max-w-2xl">
            Your village, <span className="accent">covered.</span>
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
        </div>
      </section>

      {/* ── Privacy, the Canadian way ─────────────────────────────────────── */}
      <section className="shell py-20 lg:py-28">
        <span className="eyebrow">Privacy</span>
        <h2 className="mt-3 max-w-2xl">
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
            messaging provider before it reaches you. So I write to that reality — I name the task,
            never the diagnosis.{' '}
            <a href="/privacy" className="link">
              How I handle your data
            </a>
            .
          </p>
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
              <a href={smsHref} className="btn-on-navy">
                Text me
              </a>
            </div>
          ) : (
            <div className="mt-9 flex justify-center">
              <a href={`mailto:${CONTACT_EMAIL}`} className="btn-on-navy">
                Email me
              </a>
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
 * Design book, not a dramatisation and not a screenshot. Real DOM text in a
 * plain card: no device frame, no status bar, nothing pretending to be a photo
 * of a phone. The two emoji are quoted from Hale's actual radar reply (the voice
 * rules allow one per message); the site's own chrome stays emoji-free.
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
        <Bubble from="parent">Hi</Bubble>
        <Bubble from="hale">
          Hi, I’m Hale — I keep family weeks on track for GTA parents. What are your kids’ names and
          ages — and what’s your postal code?
          <span className="mt-2 block text-[0.8rem] opacity-70">
            (I’m an assistant, not a person — details &amp; privacy: villagehale.com/privacy)
          </span>
        </Bubble>
        <Bubble from="parent">Max is 4, Mia is 18 months, L4C</Bubble>
        <Bubble from="hale">
          Here’s your week, off the top: ☀️ Saturday’s 26° — the Mill Pond splash pad is 6 minutes
          from you, free. ⏰ Richmond Hill fall swim registration opens Tue Aug 12, 7:00 a.m. —
          spots for Max’s age usually go in minutes. Want me to keep an eye on all of this for you?
        </Bubble>
        <Bubble from="parent">yes please</Bubble>
        <Bubble from="hale">
          Done — you’re covered. I’ll only text when something actually matters.
        </Bubble>
      </ol>
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
    <section className="band-cream py-16 lg:py-20">
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
