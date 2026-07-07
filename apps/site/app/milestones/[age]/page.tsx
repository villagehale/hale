import {
  ArrowUpRight,
  Footprints,
  HeartHandshake,
  Lightbulb,
  MessageCircle,
} from 'lucide-react';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ShareAgeLink } from '~/components/share-age-link';
import { SiteFooter } from '~/components/site-footer';
import { SiteHeader } from '~/components/site-header';
import { APP_URL } from '~/lib/app-url';
import {
  adjacentCheckpoints,
  allCheckpoints,
  getCheckpoint,
  type MilestoneDomain,
} from '~/lib/milestones/index';
import { MILESTONE_SOURCES } from '~/lib/milestones/sources';
import { checkpointJsonLd } from '~/lib/milestones/structured-data';
import { relatedAnswersForStage } from '~/lib/milestones/related-answers';

interface PageProps {
  params: Promise<{ age: string }>;
}

// The four CDC domains, rendered by tone not border. Each is a soft tinted panel
// with a single Lucide icon — no emoji. Order here is the on-page order.
const DOMAINS: Record<
  MilestoneDomain,
  { label: string; panel: string; icon: typeof HeartHandshake }
> = {
  'social-emotional': {
    label: 'Social and emotional',
    panel: 'panel-apricot-tint',
    icon: HeartHandshake,
  },
  'language-communication': {
    label: 'Language and communication',
    panel: 'panel-sky-tint',
    icon: MessageCircle,
  },
  cognitive: {
    label: 'Cognitive — learning and problem-solving',
    panel: 'panel-oat',
    icon: Lightbulb,
  },
  'movement-physical': {
    label: 'Movement and physical',
    panel: 'panel-sage-tint',
    icon: Footprints,
  },
};

export function generateStaticParams(): { age: string }[] {
  return allCheckpoints.map((c) => ({ age: c.slug }));
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { age } = await params;
  const checkpoint = getCheckpoint(age);
  if (!checkpoint) return {};

  const canonical = `/milestones/${checkpoint.slug}`;
  return {
    title: `${checkpoint.title} · Hale`,
    description: checkpoint.description,
    alternates: { canonical },
    // Review-before-index gate: a draft stays out of the index until a human
    // re-verifies its copy against the cited CDC URL and flips `published`.
    robots: checkpoint.published ? undefined : { index: false, follow: true },
    openGraph: {
      type: 'article',
      title: checkpoint.title,
      description: checkpoint.description,
      url: canonical,
      siteName: 'Village Hale',
      locale: 'en_CA',
    },
    twitter: {
      card: 'summary_large_image',
      title: checkpoint.title,
      description: checkpoint.description,
    },
  };
}

export default async function MilestoneAgeRoute({ params }: PageProps) {
  const { age } = await params;
  const checkpoint = getCheckpoint(age);
  if (!checkpoint) notFound();

  const { prev, next } = adjacentCheckpoints(checkpoint.slug);
  const related = relatedAnswersForStage(checkpoint.stage);

  return (
    <main id="top" className="relative">
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: JSON-LD is a serialized in-repo data object (no user input) — the standard way to emit SEO structured data.
        dangerouslySetInnerHTML={{ __html: JSON.stringify(checkpointJsonLd(checkpoint)) }}
      />
      <SiteHeader />

      <article className="shell pt-10 sm:pt-16 pb-16 lg:pb-24">
        <div className="max-w-3xl">
          <nav aria-label="Breadcrumb" className="rise rise-1">
            <a href="/milestones" className="link text-sm">
              Milestones
            </a>
          </nav>

          <div className="mt-4 rise rise-1">
            <span className="eyebrow">Around {checkpoint.ageLabel} · typical range</span>
            <h1 className="mt-3">What most children are doing around {checkpoint.ageLabel}</h1>
          </div>

          <p className="meta mt-6 rise rise-2" style={{ lineHeight: 1.6 }}>
            These are milestones most children — 75 percent or more — can do by this age, from the
            CDC’s 2022 “Learn the Signs. Act Early.” checklists, with Canadian guidance from the
            Canadian Paediatric Society. Think of it as a picture of typical, not a finish line.
            Last reviewed {checkpoint.updated}.
          </p>

          <p className="meta mt-4 rise rise-2" style={{ lineHeight: 1.6 }}>
            This isn’t a quiz, and there’s nothing to score. You can’t fail it and neither can your
            child. It’s a way to enjoy noticing what’s emerging — and to know what tends to come
            next.
          </p>

          <div className="mt-12 flex flex-col gap-6">
            {checkpoint.domains.map((group) => {
              const meta = DOMAINS[group.domain];
              const Icon = meta.icon;
              return (
                <section
                  key={group.domain}
                  className={`${meta.panel} px-6 py-7 sm:px-8 rise rise-2`}
                >
                  <div className="flex items-center gap-3">
                    <Icon
                      size={22}
                      strokeWidth={2}
                      aria-hidden="true"
                      style={{ color: 'var(--color-spruce)' }}
                    />
                    <h2 style={{ fontSize: 'clamp(1.25rem, 2.6vw, 1.6rem)' }}>{meta.label}</h2>
                  </div>
                  <ul className="mt-4 flex flex-col gap-2.5">
                    {group.items.map((item) => (
                      <li
                        key={item}
                        className="flex gap-3"
                        style={{ color: 'var(--color-slate-green)', lineHeight: 1.55 }}
                      >
                        <span
                          aria-hidden="true"
                          className="mt-2 shrink-0"
                          style={{
                            width: 6,
                            height: 6,
                            borderRadius: 9999,
                            background: 'var(--color-apricot)',
                          }}
                        />
                        <span>{item}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>

          <div className="mt-8 rise rise-2">
            <ShareAgeLink slug={checkpoint.slug} ageLabel={checkpoint.ageLabel} />
          </div>

          <div className="card mt-12 rise rise-2">
            <h2 style={{ fontSize: 'clamp(1.35rem, 2.8vw, 1.75rem)' }}>Every child is different</h2>
            <p
              className="mt-4"
              style={{ color: 'var(--color-slate-green)', lineHeight: 1.65 }}
            >
              All children develop skills at different times — the Canadian Paediatric Society notes
              it’s normal for a child to be ahead in some areas and still emerging in others at the
              same time. A child who took their first steps “late” and one who took them “early”
              usually both end up running around the playground. If your child was born early, look
              at their corrected age: their actual age minus the weeks they arrived early.
            </p>
            <a
              href={MILESTONE_SOURCES.cps.url}
              target="_blank"
              rel="noreferrer"
              className="link mt-4 inline-flex items-center gap-1.5 text-sm"
            >
              Canadian Paediatric Society — child development
              <ArrowUpRight size={14} strokeWidth={2.25} aria-hidden="true" />
            </a>
          </div>

          {(prev || next) && (
            <section className="mt-12 rise rise-2">
              <span className="eyebrow">Looking back · looking ahead</span>
              <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-5">
                {prev && (
                  <a href={`/milestones/${prev.slug}`} className="card flex flex-col gap-1.5">
                    <span className="meta">Looking back</span>
                    <span
                      className="font-display"
                      style={{ fontWeight: 600, fontSize: '1.15rem' }}
                    >
                      Around {prev.ageLabel}
                    </span>
                  </a>
                )}
                {next && (
                  <a href={`/milestones/${next.slug}`} className="card flex flex-col gap-1.5">
                    <span className="meta">Looking ahead</span>
                    <span
                      className="font-display"
                      style={{ fontWeight: 600, fontSize: '1.15rem' }}
                    >
                      Around {next.ageLabel}
                    </span>
                  </a>
                )}
              </div>
            </section>
          )}

          <section className="panel-berry-tint px-6 py-8 sm:px-8 mt-12 rise rise-2">
            <h2 style={{ fontSize: 'clamp(1.35rem, 2.8vw, 1.75rem)' }}>
              When it’s worth a chat with your provider
            </h2>
            <p className="mt-4" style={{ color: 'var(--color-slate-green)', lineHeight: 1.65 }}>
              You know your child best — that’s the CDC’s own starting point. It’s worth mentioning
              to your child’s doctor or nurse practitioner if: your child isn’t meeting one or more
              of the milestones on their age’s list; your child has lost skills they once had (this
              one matters at any age); or something just feels off to you — a parent’s concern is
              reason enough.
            </p>
            <p className="mt-4" style={{ color: 'var(--color-slate-green)', lineHeight: 1.65 }}>
              None of these mean something is wrong. They mean a conversation is useful, because if
              support is ever needed, earlier is easier. What to ask for: a developmental screening
              (routinely recommended around 9, 18, and 30 months, with autism screening at 18 and 24
              months); if concerns remain, a referral to a specialist; and in Canada, your
              provincial or territorial early-intervention or child-development program — you don’t
              need to wait for a diagnosis to ask.
            </p>
            <a
              href={MILESTONE_SOURCES.cdcConcerned.url}
              target="_blank"
              rel="noreferrer"
              className="link mt-4 inline-flex items-center gap-1.5 text-sm"
            >
              {MILESTONE_SOURCES.cdcConcerned.label}
              <ArrowUpRight size={14} strokeWidth={2.25} aria-hidden="true" />
            </a>
          </section>

          <section className="mt-14 rise rise-2">
            <h2 style={{ fontSize: 'clamp(1.5rem, 3vw, 2.1rem)' }}>Sources</h2>
            <p className="meta mt-3">
              The milestone list on this page is the CDC’s own wording for this age, rendered in
              they/them. Follow a source to read it directly.
            </p>
            <ul className="mt-6 flex flex-col gap-5">
              <li>
                <a
                  href={checkpoint.sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="link inline-flex items-center gap-1.5"
                >
                  CDC — “Learn the Signs. Act Early.” checklist for {checkpoint.ageLabel}
                  <ArrowUpRight size={14} strokeWidth={2.25} aria-hidden="true" />
                </a>
              </li>
              <li>
                <a
                  href={MILESTONE_SOURCES.cps.url}
                  target="_blank"
                  rel="noreferrer"
                  className="link inline-flex items-center gap-1.5"
                >
                  {MILESTONE_SOURCES.cps.label}
                  <ArrowUpRight size={14} strokeWidth={2.25} aria-hidden="true" />
                </a>
              </li>
            </ul>
          </section>
        </div>
      </article>

      <section className="shell pb-16 lg:pb-24">
        <div
          className="night px-8 py-12 sm:px-14 sm:py-16 max-w-3xl"
          style={{ borderRadius: 'var(--r-xl)' }}
        >
          <span className="eyebrow" style={{ color: 'var(--color-on-spruce-soft)' }}>
            Please read
          </span>
          <h2
            className="mt-3"
            style={{ color: 'var(--color-on-spruce)', fontSize: 'clamp(1.5rem, 3vw, 2.1rem)' }}
          >
            This is general guidance, not medical advice.
          </h2>
          <p className="mt-4" style={{ color: 'var(--color-on-spruce-soft)', lineHeight: 1.6 }}>
            These checklists describe typical ranges; they are not a screening test or a diagnosis,
            and the CDC itself notes they are not a substitute for standardized, validated
            developmental screening tools. Hale cannot see your child. For anything about your
            child’s health or development, talk with your paediatrician or health provider. In an
            emergency, contact your local emergency services.
          </p>
        </div>
      </section>

      <section className="shell pb-16 lg:pb-24">
        <div className="panel-apricot-tint px-8 py-14 sm:px-12 max-w-3xl">
          <p
            className="font-display"
            style={{
              fontSize: 'clamp(1.25rem, 2.4vw, 1.75rem)',
              lineHeight: 1.35,
              letterSpacing: 'var(--tracking-display)',
              fontWeight: 600,
              color: 'var(--color-spruce)',
            }}
          >
            Wondering about these for your own child? Hale keeps your child’s age in mind for you —
            every answer, suggestion, and plan is tuned to their exact stage, from newborn to teen.
            Free to start, private by design, built in Canada.
          </p>
          <div className="mt-8">
            <a href={`${APP_URL}/sign-up`} className="btn-primary">
              Start free with your family
            </a>
          </div>
          <p className="meta mt-4">
            No credit card. Your family’s data stays in Canada and is never sold.
          </p>
        </div>
      </section>

      {related.length > 0 && (
        <section className="shell pb-20 lg:pb-28">
          <span className="eyebrow">Related answers</span>
          <div className="mt-6 grid grid-cols-1 md:grid-cols-2 gap-6 lg:gap-8">
            {related.map((rel) => (
              <a
                key={rel.slug}
                href={`/answers/${rel.slug}`}
                className="card flex flex-col gap-3"
              >
                <span
                  className="font-display"
                  style={{ fontWeight: 600, fontSize: '1.2rem', lineHeight: 1.25 }}
                >
                  {rel.question}
                </span>
              </a>
            ))}
          </div>
        </section>
      )}

      <SiteFooter />
    </main>
  );
}
