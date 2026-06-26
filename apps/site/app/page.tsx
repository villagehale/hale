import { Check, Compass, Heart, Send, Users } from 'lucide-react';
import { HeroScene } from '~/components/hero-scene';
import { PricingSection } from '~/components/pricing-section';
import {
  ParentAndHouse,
  Sapling,
  SeaTurtle,
  Seed,
  Sprout,
  Sun,
  Tree,
  Village,
} from '~/components/illos';
import { SiteFooter } from '~/components/site-footer';
import { SiteHeader } from '~/components/site-header';
import { WaitlistForm } from '~/components/waitlist-form';

// Aggregate, illustrative social proof — a COUNT only, never a family identity
// (hard rule #1). Mirrors the app's endorsementLabel ("loved by N families near
// you") and the count-only SocialProofBadge on the real share surfaces. These
// are example cards on a research preview, not real recommendations.
const RECOMMENDED = [
  {
    kind: 'Story-time',
    title: 'Saturday story-time at the local branch library',
    summary:
      'A warm, free half-hour for the under-fives — songs, a picture book, a craft to take home.',
    loved: 14,
  },
  {
    kind: 'Swim',
    title: 'Parent-and-baby water class, two streets over',
    summary:
      'The gentle one new parents keep coming back to. Small groups, patient instructors, no pressure.',
    loved: 9,
  },
  {
    kind: 'Outdoors',
    title: 'The Saturday-morning park festival',
    summary:
      'The one families clear their calendar for — music, a maker tent, room for kids to just run.',
    loved: 22,
  },
] as const;

// The viral loop, made legible: discover trusted local things → share what you
// love → your village grows. Mirrors the app's share surfaces (discover, endorse,
// "join the village").
const LOOP = [
  {
    Icon: Compass,
    title: 'Discover what families like yours actually do',
    body: 'Hale gathers the genuinely good local things — the class, the story-time, the festival — matched to your kid’s age and stage, near you.',
  },
  {
    Icon: Send,
    title: 'Share the ones you love',
    body: 'One tap sends a family’s week — the handful of things worth it this week — to a friend, a group chat, the new parent down the street. No app required to open it.',
  },
  {
    Icon: Users,
    title: 'Your village grows — and so does everyone’s',
    body: 'Every family who joins adds what they’ve loved. The more your village grows, the better the recommendations get, for you and for them.',
  },
] as const;

const WEEK = [
  {
    arc: 'Newborn',
    stage: 'the first months',
    task: 'A water-babies class two streets over, a quiet drop-in for new parents on Thursday — the things nearby families swear by, surfaced for the week ahead with a gentle this is normal, you are doing fine.',
  },
  {
    arc: 'Toddler',
    stage: 'finding the world',
    task: 'Library story-time, the good Montessori with a spot opening, the park festival on Saturday — the ones other parents recommend, surfaced for their age, the registration ready when you are.',
  },
  {
    arc: 'Child',
    stage: 'growing into it',
    task: 'The soccer season that fits your week, the art class they would actually love, the field-trip form due Friday — vouched for by families near you, drafted and ready to add before they slip.',
  },
  {
    arc: 'Teenager',
    stage: 'almost grown',
    task: 'The maker-space, the volunteer hours, the permission slips you don’t want to miss — and their own privacy held: you see what kind of thing, never their messages.',
  },
] as const;

const LADDER = [
  {
    shape: <Seed style={{ height: 64, width: 'auto' }} />,
    title: 'Connect',
    body: 'Your inbox first. Your calendar second. Photos only when you trust Hale with them.',
  },
  {
    shape: <Sprout style={{ height: 80, width: 'auto' }} />,
    title: 'Observe for 7 days',
    body: 'At first Hale only watches and learns your family — the ages, the rhythm, the village you already have. No drafts, no actions, no exceptions.',
  },
  {
    shape: <Sapling style={{ height: 92, width: 'auto' }} />,
    title: 'Draft, with approval',
    body: 'After a week it begins drafting replies, appointments, orders. You approve every single one.',
  },
  {
    shape: <Tree style={{ height: 96, width: 'auto' }} />,
    title: 'Autonomy, earned',
    body: 'After five clean approvals of one kind of task, Hale may handle that kind on its own. You stay in control — withdraw any automation at any time.',
  },
] as const;

const NEVER = [
  'give medical advice — only your pediatrician will',
  'send anything to anyone you have not greenlit',
  'spend more than your per-action cap without asking',
  'share a precise location — only ever a coarse area, and only a count, never a family’s identity',
  'store your family’s core data outside Canada',
  'sell your family’s data to anyone, for any price',
] as const;

export default function LandingPage() {
  return (
    <main id="top" className="relative">
      {/* ── 1 · Hero — the village ──────────────────────────────────────── */}
      <SiteHeader />

      <section className="shell pt-10 sm:pt-16 lg:pt-20 pb-20 lg:pb-28">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-12 lg:gap-x-16 items-center">
          <div className="lg:col-span-7 rise rise-1">
            <HeroScene />
            <p className="meta mt-4 max-w-md">
              Hale turns the trusted, word-of-mouth village parents used to have —
              the neighbour who knew which class was worth it — into one you can
              actually reach, near you, online.
            </p>
          </div>

          <div className="lg:col-span-5 rise rise-2">
            <span className="eyebrow">For your neighborhood</span>
            <h1 className="mt-3">
              The <span className="accent">village</span> every parent needs.
            </h1>
            <p
              className="mt-6 text-lg"
              style={{ color: 'var(--color-slate-green)', lineHeight: 1.6 }}
            >
              Find what families like yours actually do near you — and share what
              you love. Hale is the trusted parent network for every stage of
              childhood, rebuilt so it grows with each family that joins.
            </p>
            <p className="mt-4" style={{ color: 'var(--color-faded-sage)', lineHeight: 1.55 }}>
              A calm AI concierge finds and organizes it all — but the village is
              the point: real recommendations from real families near you.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <a href="#waitlist" className="btn-primary">
                Join the village
              </a>
              <a href="#loop" className="btn-secondary">
                How it grows
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* ── 2 · The plain-language promise band — the village, online ───── */}
      <section className="shell pb-20 lg:pb-28">
        <div className="panel-oat px-8 py-14 sm:px-14 sm:py-20 lg:px-20 lg:py-24">
          <p
            className="font-display max-w-4xl"
            style={{
              fontSize: 'clamp(1.65rem, 3.4vw, 2.75rem)',
              lineHeight: 1.2,
              letterSpacing: 'var(--tracking-display)',
              fontWeight: 600,
            }}
          >
            Once, a family had a village — elders who knew which class was worth
            it, neighbors who carried the small things, a grandmother who said
            this is normal, you are doing fine. That trust still lives in
            word-of-mouth between parents — it just doesn’t scale, and you can’t
            reach it when you move. Hale puts that village online: what families
            near you actually recommend, in one place, growing with every family
            that joins.
          </p>
        </div>
      </section>

      {/* ── 3 · Social proof — what families near you recommend ─────────── */}
      <section id="village" className="shell pb-20 lg:pb-28">
        <div className="max-w-2xl mb-12 lg:mb-16">
          <span className="eyebrow">What families near you recommend</span>
          <h2 className="mt-3">Trusted by the parents down the street.</h2>
          <p
            className="mt-5 text-lg"
            style={{ color: 'var(--color-slate-green)', lineHeight: 1.6 }}
          >
            Not reviews from strangers — the genuinely good local things families
            like yours keep coming back to. You see how many families love each
            one, never who they are: an aggregate count, a coarse area, nothing
            more.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 lg:gap-8">
          {RECOMMENDED.map((item, i) => (
            <article key={item.title} className={`card flex flex-col gap-4 rise rise-${i + 1}`}>
              <span className="eyebrow">{item.kind}</span>
              <h3 className="font-display text-xl" style={{ lineHeight: 1.2 }}>
                {item.title}
              </h3>
              <p style={{ color: 'var(--color-slate-green)', lineHeight: 1.55 }}>
                {item.summary}
              </p>
              <span className="pill pill-apricot mt-auto self-start">
                <Heart size={14} strokeWidth={2.5} aria-hidden="true" />
                loved by {item.loved} families near you
              </span>
            </article>
          ))}
        </div>
        <p className="meta mt-6">
          Illustrative examples — a research preview. Counts are aggregate; no
          family is ever named.
        </p>
      </section>

      {/* ── 4 · The share artifact — the hook ───────────────────────────── */}
      <section className="shell pb-20 lg:pb-28">
        <div className="panel-sky-tint px-8 py-14 sm:px-14 sm:py-20 lg:px-20">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-12 lg:gap-x-16 items-center">
            <div className="lg:col-span-6 rise rise-1">
              <span className="eyebrow">See a family’s week</span>
              <h2 className="mt-3">One tap shares the good week. Then they join.</h2>
              <p
                className="mt-5 text-lg"
                style={{ color: 'var(--color-spruce)', lineHeight: 1.6 }}
              >
                When a friend loves their kid’s week, they send it — a clean,
                private card of the handful of things worth it near them. It opens
                in any browser, no app, no account. And at the bottom: join the
                village. That’s how it spreads, parent to parent.
              </p>
              <div className="mt-8">
                <a href="#waitlist" className="btn-primary">
                  Join the village
                </a>
              </div>
            </div>

            {/* a mocked share card — mirrors the app's PublicActivityCard look */}
            <div className="lg:col-span-6 rise rise-2">
              <div className="card flex flex-col gap-5">
                <div className="flex items-center gap-3">
                  <SeaTurtle age="young" style={{ height: 44, width: 'auto' }} />
                  <div>
                    <p className="eyebrow">A family’s week · shared by Hale</p>
                    <p className="meta">around the east end</p>
                  </div>
                </div>
                <div className="flex flex-col gap-3">
                  {RECOMMENDED.map((item) => (
                    <div
                      key={item.title}
                      className="panel-oat px-4 py-4 flex items-baseline justify-between gap-4"
                    >
                      <div>
                        <span className="eyebrow">{item.kind}</span>
                        <p
                          className="mt-1 font-display"
                          style={{ fontSize: '1.05rem', lineHeight: 1.25 }}
                        >
                          {item.title}
                        </p>
                      </div>
                      <span className="pill pill-apricot shrink-0">
                        <Heart size={13} strokeWidth={2.5} aria-hidden="true" />
                        {item.loved}
                      </span>
                    </div>
                  ))}
                </div>
                <a href="#waitlist" className="btn-primary self-start">
                  Join the village
                </a>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── 5 · The loop — discover → share → grow ──────────────────────── */}
      <section id="loop" className="shell pb-20 lg:pb-28">
        <div className="max-w-2xl mb-12 lg:mb-16">
          <span className="eyebrow">How the village grows</span>
          <h2 className="mt-3">It gets better the more it grows.</h2>
          <p
            className="mt-5 text-lg"
            style={{ color: 'var(--color-slate-green)', lineHeight: 1.6 }}
          >
            Hale is a network, not a directory. Every family who joins makes the
            recommendations better for everyone near them — the more your village
            grows, the more it knows what’s actually worth your week.
          </p>
        </div>

        <ol className="grid grid-cols-1 md:grid-cols-3 gap-x-10 gap-y-12">
          {LOOP.map((step, i) => (
            <li key={step.title} className={`rise rise-${i + 1}`}>
              <span
                className="inline-flex h-12 w-12 items-center justify-center rounded-full"
                style={{ background: 'var(--color-apricot-tint)' }}
                aria-hidden
              >
                <step.Icon size={22} strokeWidth={2} style={{ color: 'var(--color-apricot-deep)' }} />
              </span>
              <h3 className="mt-5">{step.title}</h3>
              <p className="mt-3" style={{ color: 'var(--color-slate-green)', lineHeight: 1.55 }}>
                {step.body}
              </p>
            </li>
          ))}
        </ol>

        <div className="mt-14 panel-apricot-tint px-8 py-10 sm:px-12 flex flex-col sm:flex-row sm:items-center gap-6 sm:gap-10">
          <Village style={{ width: 'clamp(180px, 30vw, 260px)', height: 'auto' }} />
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
            Your village starts the day you join — one family, then a street, then
            a neighborhood. Invite the parents you trust, and it’s yours.
          </p>
        </div>
      </section>

      {/* ── 6 · The good local week — every stage ───────────────────────── */}
      <section className="shell pb-20 lg:pb-28">
        <div className="max-w-2xl mb-12 lg:mb-16">
          <span className="eyebrow">The good local week</span>
          <h2 className="mt-3">One childhood, every stage — the same village.</h2>
          <p
            className="mt-5 text-lg"
            style={{ color: 'var(--color-slate-green)', lineHeight: 1.6 }}
          >
            From the first months to almost grown, the village surfaces the
            genuinely good things near you — vouched for by families ahead of you —
            and the concierge brings them within reach, one at a time. It grows up
            alongside your kid, and the week grows with them.
          </p>
        </div>

        <ol className="relative grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-x-10 gap-y-14">
          {WEEK.map((moment, i) => (
            <li key={moment.arc} className={`rise rise-${i + 1}`}>
              <div className="flex items-end gap-3 h-[120px]" aria-hidden>
                {i === 0 && <Sun style={{ height: 72, width: 'auto' }} />}
                {i === 1 && <SeaTurtle age="young" style={{ height: 110, width: 'auto' }} />}
                {i === 2 && <SeaTurtle age="adult" style={{ height: 118, width: 'auto' }} />}
                {i === 3 && <SeaTurtle age="elder" style={{ height: 122, width: 'auto' }} />}
              </div>
              <div className="mt-5 flex items-baseline gap-3">
                <span className="font-display text-xl font-semibold accent">{moment.arc}</span>
                <span className="eyebrow">{moment.stage}</span>
              </div>
              <p className="mt-3" style={{ color: 'var(--color-slate-green)', lineHeight: 1.55 }}>
                {moment.task}
              </p>
            </li>
          ))}
        </ol>
      </section>

      {/* ── 7 · Trust, earned slowly — the concierge ────────────────────── */}
      <section id="how" className="shell pb-20 lg:pb-28">
        <div className="max-w-2xl mb-12 lg:mb-16">
          <span className="eyebrow">The concierge, trust earned slowly</span>
          <h2 className="mt-3">The AI that powers it never acts until you say so.</h2>
          <p
            className="mt-5 text-lg"
            style={{ color: 'var(--color-slate-green)', lineHeight: 1.6 }}
          >
            The village is the moat; the concierge is how it gets done. It finds,
            organizes, and — only once you’ve let it — handles the small tasks.
            Autonomy is grown, never assumed.
          </p>
        </div>

        <ol className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-x-10 gap-y-12 items-end">
          {LADDER.map((step, i) => (
            <li key={step.title} className={`rise rise-${i + 1}`}>
              <div className="flex items-end h-[100px]" aria-hidden>
                {step.shape}
              </div>
              <h3 className="mt-5">{step.title}</h3>
              <p className="mt-3" style={{ color: 'var(--color-slate-green)', lineHeight: 1.55 }}>
                {step.body}
              </p>
            </li>
          ))}
        </ol>
      </section>

      {/* ── 8 · Three sizes of help (pricing) ───────────────────────────── */}
      <PricingSection />

      {/* ── 9 · Hale will never — the inverted night section ─────────────── */}
      <section className="night py-24 lg:py-32">
        <div className="shell grid grid-cols-1 lg:grid-cols-12 gap-y-12 lg:gap-x-16">
          <div className="lg:col-span-4">
            <span className="eyebrow" style={{ color: 'var(--color-on-spruce-soft)' }}>
              The promises
            </span>
            <h2 className="mt-3" style={{ color: 'var(--color-on-spruce)' }}>
              Hale will never.
            </h2>
            <p
              className="mt-6"
              style={{ color: 'var(--color-on-spruce-soft)', lineHeight: 1.6, maxWidth: '24rem' }}
            >
              A village runs on trust. This is the compliance core — PIPEDA,
              Quebec Law 25, and Canadian data residency live here, not in fine
              print.
            </p>
          </div>

          <ul className="lg:col-span-8 flex flex-col gap-7">
            {NEVER.map((promise) => (
              <li key={promise} className="flex gap-4 items-start text-lg lg:text-xl">
                <span
                  className="shrink-0 mt-1 inline-flex h-7 w-7 items-center justify-center rounded-full"
                  style={{ background: 'var(--color-apricot)' }}
                  aria-hidden
                >
                  <Check size={18} strokeWidth={2.5} style={{ color: 'var(--color-spruce)' }} />
                </span>
                <span style={{ lineHeight: 1.4, color: 'var(--color-on-spruce)' }}>{promise}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* ── 10 · A note from the maker ──────────────────────────────────── */}
      <section className="shell py-24 lg:py-32">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-10 lg:gap-x-16 items-center">
          <div className="lg:col-span-3 flex justify-center lg:justify-start">
            <ParentAndHouse style={{ width: 'clamp(140px, 22vw, 180px)', height: 'auto' }} />
          </div>
          <div className="lg:col-span-9">
            <span className="eyebrow">A note from the maker</span>
            <p
              className="mt-5 font-display max-w-3xl"
              style={{
                fontSize: 'clamp(1.4rem, 2.6vw, 2rem)',
                lineHeight: 1.32,
                letterSpacing: 'var(--tracking-display)',
                fontWeight: 600,
              }}
            >
              My partner and I were raising a kid far from the village our own
              parents had — no elders down the street, no one who just knew which
              class was worth it or that this hard week was normal. The trust was
              still out there, in what other parents quietly told each other; we
              just couldn’t reach it. So I built a way to put that village online —
              the things families near you swear by, easy to share, growing with
              every family that joins.
            </p>
            <p className="mt-6 meta">— Barton, Toronto</p>
          </div>
        </div>
      </section>

      {/* ── 11 · Waitlist close ─────────────────────────────────────────── */}
      <section id="waitlist" className="shell pb-24 lg:pb-32">
        <div className="panel-oat px-8 py-14 sm:px-14 sm:py-20 lg:px-20">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-10 lg:gap-x-16 items-center">
            <div className="lg:col-span-6">
              <h2>Join your family’s village.</h2>
              <p
                className="mt-6 text-lg"
                style={{ color: 'var(--color-slate-green)', lineHeight: 1.6 }}
              >
                Free for one year in exchange for honest feedback. Your family’s
                data stays in Canada. PIPEDA + Quebec Law 25 + CASL compliant by
                default. Leave any time and take your family graph with you.
              </p>
            </div>
            <div className="lg:col-span-6">
              <WaitlistForm />
            </div>
          </div>
        </div>
      </section>

      <SiteFooter />
    </main>
  );
}
