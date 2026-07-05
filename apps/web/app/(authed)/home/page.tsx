import { Baby } from 'lucide-react';
import Link from 'next/link';
import { Suspense } from 'react';
import { ActivationPanel } from '~/components/hale/activation-panel';
import { BookButton } from '~/components/hale/book-button';
import { scopeChildren } from '~/components/hale/child-scope-core';
import { ConciergeAsk } from '~/components/hale/concierge-ask';
import { HomeChildFilter } from '~/components/hale/home-child-filter';
import { LongDate } from '~/components/hale/long-date';
import { QuickLog } from '~/components/hale/quick-log';
import { HomeVillageFeed, VillageFeedSkeleton } from '~/components/hale/village-feed-section';
import { Card } from '~/components/ui/card';
import { Icon } from '~/components/ui/icon';
import { allStepsDone, deriveActivationSteps } from '~/lib/activation/checklist';
import { authConfigured } from '~/lib/auth-config';
import { loadThreadShellForRequest } from '~/lib/coach/thread';
import { type ChildCompanionView, loadCompanion } from '~/lib/companion/queries';
import { loadFamilyMembers } from '~/lib/dashboard/queries';
import { loadVillage } from '~/lib/village/queries';

function duePhrase(dueInWeeks: number): string {
  if (dueInWeeks <= 0) return 'due now';
  if (dueInWeeks === 1) return 'due in 1 week';
  if (dueInWeeks < 8) return `due in ${dueInWeeks} weeks`;
  const months = Math.round(dueInWeeks / 4.345);
  return `due in ~${months} ${months === 1 ? 'month' : 'months'}`;
}

/** The single milestone worth nudging now: prefer one inside its window. */
function milestoneInWindow(child: ChildCompanionView) {
  return child.milestones.find((m) => m.timing === 'in_window') ?? child.milestones[0] ?? null;
}

export default async function HomePage() {
  const canAsk = authConfigured();
  const [children, askSeed, village, members] = await Promise.all([
    loadCompanion(),
    loadThreadShellForRequest(),
    loadVillage(),
    loadFamilyMembers(),
  ]);

  if (children.length === 0) {
    return (
      <div>
        <div className="page-corner">
          <span className="ml-auto">
            <LongDate />
          </span>
        </div>

        <header className="rise rise-1 mb-12 lg:mb-16">
          <h1 className="font-display">
            welcome to <span className="text-apricot-deep">Hale</span>.
          </h1>
        </header>

        <section className="rise rise-3 panel-oat px-6 py-12 lg:py-16 text-center space-y-4">
          <p className="font-display text-[1.5rem] lg:text-[1.875rem] text-spruce">
            tell Hale about your kid.
          </p>
          <p className="meta text-slate-green max-w-xl mx-auto">
            add your child&rsquo;s birthday and your area, and this page fills with your village —
            the genuinely good local things families like yours recommend near you, ranked for your
            family.
          </p>
          <div className="pt-2">
            <Link href="/onboarding" className="btn-primary">
              set up your family →
            </Link>
          </div>
        </section>

        <section className="rise rise-4 mt-12">
          <ConciergeAsk canAsk={canAsk} seed={askSeed} />
        </section>
      </div>
    );
  }

  const activationSignals = {
    acceptedCandidateCount: village.candidates.filter((c) => c.accepted).length,
    hasUserCoachMessage: askSeed.timeline.some((m) => m.role === 'user'),
    hasCoParent: members.coParent !== null,
  };
  const showActivation = !allStepsDone(activationSignals);

  return (
    <div>
      <div className="page-corner">
        <span className="ml-auto">
          <LongDate />
        </span>
      </div>

      {/* ── Home identity — the warm front door (the runninghead is gone on
       * desktop, so home carries its own header). One apricot accent on the
       * verb Hale performs for you; the feed's own header sits below. ─────── */}
      <header className="rise rise-1 mb-12 lg:mb-16">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-6 lg:gap-x-12">
          <div className="lg:col-span-3">
            <span className="eyebrow">your home</span>
            <p className="meta mt-2">everything your family needs, in one calm place</p>
          </div>
          <div className="lg:col-span-9">
            <h1 className="font-display">
              your village, <span className="text-apricot-deep">gathered</span> for you.
            </h1>
          </div>
        </div>
      </header>

      {/* ── First-run activation — auto-hides once the loop is found ──────── */}
      {showActivation ? (
        <section className="rise rise-2 mb-16 lg:mb-20">
          <ActivationPanel steps={deriveActivationSteps(activationSignals)} />
        </section>
      ) : null}

      {/* ── The village — the agent-ranked, trusted feed (the hero) ──────── */}
      {/* Streamed: the rank-recommendations agent must not block the shell. */}
      <section className="rise rise-2 mb-16 lg:mb-20">
        <Suspense fallback={<VillageFeedSkeleton />}>
          <HomeVillageFeed />
        </Suspense>
      </section>

      {/* ── Ask Hale — the concierge (present, not the hero) ─────────────── */}
      <section className="rise rise-3 mb-16 lg:mb-20">
        <ConciergeAsk canAsk={canAsk} seed={askSeed} />
      </section>

      {/* ── Today, per child (the quiet Companion — distinct from the village) ─ */}
      <section>
        <HomeChildFilter
          kids={scopeChildren(children)}
          sections={children.map((child, idx) => {
            const milestone = milestoneInWindow(child);
            const nextHealth = child.todayHealth;
            const whatsNow = child.whatsNow[0] ?? null;
            const delay = `rise-${Math.min(idx + 4, 7)}`;
            return {
              childId: child.id,
              node: (
                <article className={`rise ${delay}`}>
                  <div className="flex items-center gap-3 border-b border-rule pb-4 mb-6">
                    <Icon as={Baby} size={20} className="text-apricot-deep" />
                    <h2 className="font-display text-[1.5rem] lg:text-[1.875rem] leading-tight">
                      today for <span data-hale-pii>{child.name ?? 'your child'}</span>
                    </h2>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                    {nextHealth ? (
                      <Card>
                        <span className="eyebrow text-apricot-deep">
                          {duePhrase(nextHealth.dueInWeeks)}
                        </span>
                        <p className="font-display text-[1.25rem] mt-2 leading-snug" data-hale-pii>
                          {nextHealth.what}
                        </p>
                        <p className="meta mt-3 text-slate-green" data-hale-pii>
                          {nextHealth.note}
                        </p>
                        <div className="mt-4">
                          <BookButton what={nextHealth.what} childId={child.id} />
                        </div>
                      </Card>
                    ) : whatsNow ? (
                      <Card href="/companion">
                        <span className="eyebrow">what matters now</span>
                        <p className="font-display text-[1.25rem] mt-2 leading-snug" data-hale-pii>
                          {whatsNow}
                        </p>
                        <span className="link mt-4 inline-block">
                          see <span data-hale-pii>{child.name ?? 'your child'}</span> →
                        </span>
                      </Card>
                    ) : null}

                    {milestone ? (
                      <Card href="/companion">
                        <span className="eyebrow">around this age</span>
                        <p className="font-display text-[1.25rem] mt-2 leading-snug" data-hale-pii>
                          {milestone.what}
                        </p>
                        <p className="meta mt-3 text-slate-green">
                          most kids, around this stage — never a verdict.
                        </p>
                        <span className="link mt-4 inline-block">
                          see <span data-hale-pii>{child.name ?? 'your child'}</span> →
                        </span>
                      </Card>
                    ) : null}
                  </div>
                </article>
              ),
            };
          })}
        />
      </section>

      {/* ── Quick-log ───────────────────────────────────────────────────── */}
      <section className="rise rise-7 mt-16 lg:mt-20 pt-10 border-t border-rule space-y-4">
        <QuickLog kids={children.map((c) => ({ id: c.id, name: c.name, stage: c.stage }))} />
      </section>
    </div>
  );
}
