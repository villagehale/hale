import { ArrowUpRight, Sparkles } from 'lucide-react';
import type { Metadata } from 'next';
import { BirthdayHelper } from '~/components/birthday-helper';
import { CtaBand } from '~/components/cta-band';
import { SeaTurtle } from '~/components/illos';
import { SiteFooter } from '~/components/site-footer';
import { SiteHeader } from '~/components/site-header';
import { APP_URL } from '~/lib/app-url';
import { allCheckpoints, publishedCheckpoints } from '~/lib/milestones/index';
import { MILESTONE_SOURCES } from '~/lib/milestones/sources';
import { hubJsonLd } from '~/lib/milestones/structured-data';

// The hub lists reviewed (published) checkpoints in its structured data; until at
// least one age is published it has nothing to index, so it stays out of search
// and becomes indexable once the first age goes live — same gate as /answers.
export const metadata: Metadata = {
  title: 'Child development milestones by age · Hale',
  description:
    "What's typical at your child's age, from the CDC's milestone checklists with Canadian guidance from the CPS. A free explorer — no account, nothing collected, nothing to score.",
  alternates: { canonical: '/milestones' },
  robots: publishedCheckpoints.length > 0 ? undefined : { index: false, follow: true },
};

// Visual groupings of the twelve checkpoints — SEO-native <a> links, keyboard
// friendly, never buttons. Labels read "Around N", never "N-month test".
const CHIP_GROUPS: { label: string; slugs: string[] }[] = [
  { label: 'First year', slugs: ['2-months', '4-months', '6-months', '9-months', '12-months'] },
  { label: 'Toddler', slugs: ['15-months', '18-months', '2-years', '30-months'] },
  { label: 'Preschool', slugs: ['3-years', '4-years', '5-years'] },
];

export default function MilestonesHubPage() {
  const bySlug = new Map(allCheckpoints.map((c) => [c.slug, c]));

  return (
    <main id="top" className="relative">
      {publishedCheckpoints.length > 0 && (
        <script
          type="application/ld+json"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: JSON-LD is a serialized in-repo data object (no user input) — the standard way to emit SEO structured data.
          dangerouslySetInnerHTML={{ __html: JSON.stringify(hubJsonLd(publishedCheckpoints)) }}
        />
      )}
      <SiteHeader />

      <section className="shell pt-10 sm:pt-16 pb-8">
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_auto] gap-10 lg:gap-16 items-start">
          <div className="max-w-2xl rise rise-1">
            <span className="pill-eyebrow">
              <Sparkles size={14} strokeWidth={2} aria-hidden="true" />
              Free milestone explorer
            </span>
            <h1 className="mt-4">
              What’s <span className="accent">typical</span> at your child’s age
            </h1>
            <p className="mt-5 text-lg" style={{ color: 'var(--color-slate-green)', lineHeight: 1.6 }}>
              These are the things most children — 75 percent or more — can do by a certain age,
              from the CDC’s milestone checklists. A picture of typical, not a finish line. There’s
              nothing to score, and nothing to fail.
            </p>
          </div>
          <div className="hidden lg:block" aria-hidden="true">
            <SeaTurtle age="young" className="turtle-bob" />
          </div>
        </div>
      </section>

      <section className="shell pb-8">
        <div className="max-w-2xl rise rise-2">
          {CHIP_GROUPS.map((group) => (
            <div key={group.label} className="mt-6 first:mt-0">
              <span className="eyebrow">{group.label}</span>
              <div className="mt-3 flex flex-wrap gap-2.5">
                {group.slugs.map((slug) => {
                  const c = bySlug.get(slug);
                  if (!c) return null;
                  return (
                    <a key={slug} href={`/milestones/${slug}`} className="pill pill-sky">
                      Around {c.ageLabel}
                    </a>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="shell pb-8">
        <div className="panel-oat px-6 py-8 sm:px-8 max-w-2xl rise rise-2">
          <h2 style={{ fontSize: 'clamp(1.15rem, 2.4vw, 1.5rem)' }}>
            Not sure of the age? Use a birthday
          </h2>
          <p className="meta mt-2" style={{ lineHeight: 1.5 }}>
            We’ll show you the checkpoint at or below your child’s age — the list most children
            their age already do.
          </p>
          <div className="mt-5">
            <BirthdayHelper />
          </div>
          <p className="meta mt-5" style={{ lineHeight: 1.5 }}>
            Born early? Use corrected age — your child’s actual age minus the weeks they arrived
            early.{' '}
            <a
              href={MILESTONE_SOURCES.cps.url}
              target="_blank"
              rel="noreferrer"
              className="link inline-flex items-center gap-1"
            >
              Why corrected age
              <ArrowUpRight size={13} strokeWidth={2.25} aria-hidden="true" />
            </a>
          </p>
        </div>
      </section>

      <CtaBand>
        <p
          className="mx-auto max-w-2xl font-display"
          style={{
            fontSize: 'clamp(1.25rem, 2.4vw, 1.75rem)',
            lineHeight: 1.35,
            letterSpacing: 'var(--tracking-display)',
            fontWeight: 600,
          }}
        >
          Wondering about these for your own child? Hale keeps your child’s age in mind for you —
          every answer, suggestion, and plan is tuned to their exact stage, from newborn to teen.
          Free to start, private by design, built in Canada.
        </p>
        <div className="mt-8 flex justify-center">
          <a href={`${APP_URL}/sign-up`} className="btn-on-navy">
            Start free with your family
          </a>
        </div>
        <p className="cta-sub mx-auto mt-4 max-w-md">
          No credit card. Your family’s data stays in Canada and is never sold.
        </p>
      </CtaBand>

      <SiteFooter />
    </main>
  );
}
