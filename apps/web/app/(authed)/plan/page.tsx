import { ArrowRight } from 'lucide-react';
import { AddPlan } from '~/components/hale/add-plan';
import type { ScopeChild } from '~/components/hale/child-scope';
import { DeletePlanButton } from '~/components/hale/delete-plan-button';
import { PageCorner } from '~/components/hale/page-corner';
import { ShareWeekButton } from '~/components/hale/share-week-button';
import { Card } from '~/components/ui/card';
import { Icon } from '~/components/ui/icon';
import { loadCompanion } from '~/lib/companion/queries';
import { type AuthoredPlanView, loadAuthoredPlans } from '~/lib/plan/authored';
import { type PlanChildItem, planChildItems } from '~/lib/plan/week';
import { loadVillage } from '~/lib/village/queries';

export default async function PlanPage() {
  const [village, children, authoredPlans] = await Promise.all([
    loadVillage(),
    loadCompanion(),
    loadAuthoredPlans(),
  ]);
  const { routine } = village;
  const addedActivities = village.candidates.filter((c) => c.accepted && !c.teenAttributed);
  const childItems = planChildItems(children);
  const hasRoutine = (routine?.items.length ?? 0) > 0;
  const hasPlan =
    hasRoutine ||
    childItems.length > 0 ||
    addedActivities.length > 0 ||
    authoredPlans.length > 0;

  // A teen's given name is withheld from the parent-facing scope chip (rule #1);
  // ChildScope renders "your teen" for a null label.
  const scopeChildren: ScopeChild[] = children.map((child) => ({
    id: child.id,
    label: child.stage === 'teenager' ? null : child.name,
  }));

  return (
    <div>
      <PageCorner folio="plan" section="your week" />

      {/* ── Headline ────────────────────────────────────────────────────── */}
      <header className="rise rise-1 mb-16 lg:mb-24">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-8 lg:gap-x-12">
          <div className="lg:col-span-3">
            <span className="eyebrow">your week</span>
            <p className="meta mt-2">what&rsquo;s coming for your kids</p>
          </div>
          <div className="lg:col-span-9">
            <h1 className="font-display">
              {hasPlan ? (
                <>
                  here&rsquo;s your <span className="text-apricot-deep">week ahead</span>.
                </>
              ) : (
                <>
                  a quiet <span className="text-apricot-deep">week ahead</span>.
                </>
              )}
            </h1>
          </div>
        </div>
      </header>

      {/* ── Add a plan ──────────────────────────────────────────────────── */}
      <section className="rise rise-2 mb-16 lg:mb-20">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-6 lg:gap-x-12 border-t border-rule pt-10">
          <div className="lg:col-span-3">
            <span className="eyebrow text-spruce">your own plans</span>
            <p className="meta mt-2">a private note for your week</p>
          </div>
          <div className="lg:col-span-9">
            <AddPlan kids={scopeChildren} />
          </div>
        </div>
      </section>

      {/* ── Plans you've written ────────────────────────────────────────── */}
      {authoredPlans.length > 0 ? (
        <section className="rise rise-2 mb-16 lg:mb-20">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-6 lg:gap-x-12 border-t border-rule pt-10">
            <div className="lg:col-span-3">
              <span className="eyebrow text-spruce">plans you&rsquo;ve written</span>
              <p className="meta mt-2">private to your family</p>
            </div>
            <div className="lg:col-span-9 grid grid-cols-1 md:grid-cols-2 gap-6">
              {authoredPlans.map((plan) => (
                <AuthoredPlanCard key={plan.id} plan={plan} />
              ))}
            </div>
          </div>
        </section>
      ) : null}

      {/* ── Added to your week ──────────────────────────────────────────── */}
      {addedActivities.length > 0 ? (
        <section className="rise rise-2 mb-16 lg:mb-20">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-6 lg:gap-x-12 border-t border-rule pt-10">
            <div className="lg:col-span-3">
              <span className="eyebrow text-spruce">added to your week</span>
              <p className="meta mt-2">activities you&rsquo;ve chosen</p>
            </div>
            <div className="lg:col-span-9 grid grid-cols-1 md:grid-cols-2 gap-6">
              {addedActivities.map((candidate) => (
                <Card key={candidate.id} href="/village">
                  <span className="eyebrow text-spruce">{candidate.kind}</span>
                  <p className="text-lg text-spruce leading-relaxed mt-3">{candidate.title}</p>
                  <span className="meta mt-4 inline-flex items-center gap-1.5 text-apricot-deep">
                    open in village
                    <Icon as={ArrowRight} size={14} />
                  </span>
                </Card>
              ))}
            </div>
          </div>
        </section>
      ) : null}

      {/* ── This week's routine ─────────────────────────────────────────── */}
      {routine && hasRoutine ? (
        <section className="rise rise-2 mb-16 lg:mb-20">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-6 lg:gap-x-12 border-t border-rule pt-10">
            <div className="lg:col-span-3">
              <span className="eyebrow text-spruce">a gentle routine</span>
              <p className="meta mt-2">week of {routine.weekOf}</p>
              <div className="mt-5">
                <ShareWeekButton />
              </div>
            </div>
            <div className="lg:col-span-9 grid grid-cols-1 md:grid-cols-2 gap-6">
              {routine.items.map((item, idx) => (
                <Card key={`${item.kind}-${idx}`} href="/village">
                  <span className="eyebrow text-spruce">{item.kind}</span>
                  <div data-hale-pii>
                    <p className="text-lg text-spruce leading-relaxed mt-3">{item.title}</p>
                    {item.stageNote ? (
                      <p className="meta mt-1 text-slate-green">{item.stageNote}</p>
                    ) : null}
                  </div>
                  <span className="meta mt-4 inline-flex items-center gap-1.5 text-apricot-deep">
                    open in village
                    <Icon as={ArrowRight} size={14} />
                  </span>
                </Card>
              ))}
            </div>
          </div>
        </section>
      ) : null}

      {/* ── Coming up for your kids ─────────────────────────────────────── */}
      {childItems.length > 0 ? (
        <section className="rise rise-3 mb-16">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-6 lg:gap-x-12 border-t border-rule pt-10">
            <div className="lg:col-span-3">
              <span className="eyebrow text-spruce">coming up</span>
              <p className="meta mt-2">checkups · immunizations · milestones</p>
            </div>
            <div className="lg:col-span-9 grid grid-cols-1 md:grid-cols-2 gap-6">
              {childItems.map((item) => (
                <PlanItemCard key={item.key} item={item} />
              ))}
            </div>
          </div>
          <p className="meta mt-6 lg:ml-[25%] lg:pl-12 text-slate-green">
            timing is the standard Canadian schedule — confirm with your provider or local public
            health.
          </p>
        </section>
      ) : null}

      {/* ── Empty state ─────────────────────────────────────────────────── */}
      {!hasPlan ? (
        <section className="rise rise-3 panel-oat px-6 py-12 lg:py-16 text-center">
          <p className="font-display text-[1.5rem] lg:text-[1.875rem] text-spruce">
            nothing scheduled yet this week.
          </p>
          <p className="meta mt-4 text-slate-green">
            once your kids&rsquo; birthdays and your area are on file, this page gathers the week
            ahead — the routine for your family, what&rsquo;s coming up for each child, and the
            activities you add from your village.
          </p>
        </section>
      ) : null}

      {/* ── Colophon ────────────────────────────────────────────────────── */}
      <section className="rise rise-7 mt-16 lg:mt-24 space-y-10">
        <div className="panel-oat px-6 py-5 flex flex-wrap items-center gap-x-6 gap-y-2">
          {[
            'always confirm health and milestones with your provider',
            "your family's data stays in canada · pipeda",
          ].map((note) => (
            <span key={note} className="meta">
              {note}
            </span>
          ))}
        </div>

        <div className="flex flex-wrap items-baseline justify-between gap-y-3 text-faded-sage">
          <p className="meta">your week</p>
          <p className="meta">gathered by Hale</p>
        </div>
      </section>
    </div>
  );
}

function AuthoredPlanCard({ plan }: { plan: AuthoredPlanView }) {
  const scope = plan.childId === null ? 'whole family' : (plan.childName ?? 'your teen');
  const when = plan.scheduledFor
    ? new Date(plan.scheduledFor).toLocaleDateString('en-CA', {
        month: 'short',
        day: 'numeric',
      })
    : null;
  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <span className="eyebrow text-spruce">
          <span data-hale-pii>{scope}</span>
          {when ? ` · ${when}` : null}
        </span>
        <DeletePlanButton planId={plan.id} />
      </div>
      <p className="text-lg text-spruce leading-relaxed mt-3" data-hale-pii>
        {plan.title}
      </p>
      {plan.notes ? (
        <p className="meta mt-1 text-slate-green" data-hale-pii>
          {plan.notes}
        </p>
      ) : null}
    </Card>
  );
}

function PlanItemCard({ item }: { item: PlanChildItem }) {
  return (
    <Card href="/companion">
      <span className="eyebrow text-spruce">{item.kindLabel}</span>
      <p className="text-lg text-spruce leading-relaxed mt-3" data-hale-pii>
        {item.what}
      </p>
      <p className="meta mt-1 text-slate-green">
        <span data-hale-pii>{item.childName}</span> · {item.when}
      </p>
      <span className="meta mt-4 inline-flex items-center gap-1.5 text-apricot-deep">
        open in companion
        <Icon as={ArrowRight} size={14} />
      </span>
    </Card>
  );
}
