import { ArrowRight } from 'lucide-react';
import { AddPlan } from '~/components/hale/add-plan';
import { scopeChildren } from '~/components/hale/child-scope-core';
import { ChildTag } from '~/components/hale/child-tag';
import { CompletePlanButton } from '~/components/hale/complete-plan-button';
import { DeletePlanButton } from '~/components/hale/delete-plan-button';
import { PrivacyNote } from '~/components/hale/privacy-note';
import { ShareWeekButton } from '~/components/hale/share-week-button';
import { Card } from '~/components/ui/card';
import { Icon } from '~/components/ui/icon';
import { loadCompanion } from '~/lib/companion/queries';
import { loadFamilyTimezone } from '~/lib/dashboard/queries';
import { formatCalendarDate } from '~/lib/format/datetime';
import { villageKindLabel } from '~/lib/format/labels';
import { type AuthoredPlanView, loadAuthoredPlans } from '~/lib/plan/authored';
import { type DayColumn, buildPlanSpine, groupRoutineByDay } from '~/lib/plan/spine';
import { type PlanChildItem, planChildItems } from '~/lib/plan/week';
import { loadVillage } from '~/lib/village/queries';

/** A clean, minimal section label (Notion/Linear register) — small, muted,
 * spaced above its content. Replaces the editorial label-rail gutters. */
function SectionLabel({ children }: { children: React.ReactNode }) {
  return <p className="eyebrow mb-3 text-faded-sage">{children}</p>;
}

export default async function PlanPage() {
  const [village, children, authoredPlans, timeZone] = await Promise.all([
    loadVillage(),
    loadCompanion(),
    loadAuthoredPlans(),
    loadFamilyTimezone(),
  ]);
  const { routine } = village;
  const addedActivities = village.candidates.filter((c) => c.accepted && !c.teenAttributed);
  const childItems = planChildItems(children);
  const hasRoutine = (routine?.items.length ?? 0) > 0;

  const spine = buildPlanSpine(authoredPlans, new Date(), timeZone);
  const spineHasDated = spine.days.some((d) => d.plans.length > 0);
  const hasAuthored = spineHasDated || spine.undated.length > 0;

  const hasPlan =
    hasRoutine ||
    childItems.length > 0 ||
    addedActivities.length > 0 ||
    hasAuthored ||
    spine.settled.length > 0;

  const kids = scopeChildren(children);

  return (
    <div>
      {/* ── Greeting — a modest, app-like header (Notion/Linear register) ── */}
      <header className="rise rise-1 mb-8">
        <h1 className="font-display text-[1.75rem] lg:text-[2rem] leading-tight">
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
        <p className="meta mt-1 text-slate-green">what&rsquo;s coming for your kids.</p>
      </header>

      {/* ── Add a plan ──────────────────────────────────────────────────── */}
      <section className="rise rise-2 mb-8">
        <SectionLabel>your own plans · a private note for your week</SectionLabel>
        <AddPlan kids={kids} />
      </section>

      {/* ── Plans you've written — a Mon–Sun week-spine ─────────────────── */}
      {hasAuthored ? (
        <section className="rise rise-2 mb-8">
          <SectionLabel>plans you&rsquo;ve written · private to your family</SectionLabel>
          <div className="space-y-6">
            {spineHasDated ? (
              <div className="space-y-6">
                {spine.days
                  .filter((day) => day.plans.length > 0)
                  .map((day) => (
                    <DaySpineRow key={day.dateKey} day={day} />
                  ))}
              </div>
            ) : null}

            {spine.undated.length > 0 ? (
              <div>
                <span className="eyebrow text-slate-green">sometime this week</span>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-3">
                  {spine.undated.map((plan) => (
                    <AuthoredPlanCard key={plan.id} plan={plan} />
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </section>
      ) : null}

      {/* ── Settled — completed or past-dated, rolled out of the active week ─ */}
      {spine.settled.length > 0 ? (
        <section className="rise rise-2 mb-8">
          <SectionLabel>settled · done &amp; past, kept in your trail</SectionLabel>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {spine.settled.map((plan) => (
              <AuthoredPlanCard key={plan.id} plan={plan} settled />
            ))}
          </div>
        </section>
      ) : null}

      {/* ── Added to your week ──────────────────────────────────────────── */}
      {addedActivities.length > 0 ? (
        <section className="rise rise-2 mb-8">
          <SectionLabel>added to your week · activities you&rsquo;ve chosen</SectionLabel>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {addedActivities.map((candidate) => {
              const kindLabel = villageKindLabel(candidate.kind);
              return (
                <Card key={candidate.id} href="/village">
                  {kindLabel ? (
                    <span className="eyebrow text-spruce">{kindLabel}</span>
                  ) : null}
                  <p className="text-lg text-spruce leading-relaxed mt-3">{candidate.title}</p>
                  <span className="meta mt-4 inline-flex items-center gap-1.5 text-apricot-deep">
                    open in village
                    <Icon as={ArrowRight} size={14} />
                  </span>
                </Card>
              );
            })}
          </div>
        </section>
      ) : null}

      {/* ── This week's routine ─────────────────────────────────────────── */}
      {routine && hasRoutine ? (
        <section className="rise rise-2 mb-8">
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-y-2">
            <p className="eyebrow text-faded-sage">
              a gentle routine · week of {formatCalendarDate(routine.weekOf)}
            </p>
            <ShareWeekButton />
          </div>
          <div className="space-y-6">
            {groupRoutineByDay(routine.items).map((strip) => (
              <div key={strip.weekday ?? 'anytime'}>
                <span className="eyebrow text-slate-green">{strip.weekday ?? 'anytime'}</span>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-3">
                  {strip.items.map((item, idx) => {
                    const kindLabel = villageKindLabel(item.kind);
                    return (
                      <Card key={`${strip.weekday ?? 'x'}-${item.kind}-${idx}`} href="/village">
                        {kindLabel ? (
                          <span className="eyebrow text-spruce">{kindLabel}</span>
                        ) : null}
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
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {/* ── Coming up for your kids ─────────────────────────────────────── */}
      {childItems.length > 0 ? (
        <section className="rise rise-3 mb-8">
          <SectionLabel>coming up · checkups · immunizations · milestones</SectionLabel>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {childItems.map((item) => (
              <PlanItemCard key={item.key} item={item} />
            ))}
          </div>
          <p className="meta mt-4 text-slate-green">
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
      <section className="rise rise-7 mt-12 space-y-6">
        <div className="panel-oat px-6 py-5 flex flex-wrap items-center gap-x-6 gap-y-2">
          <span className="meta">always confirm health and milestones with your provider</span>
          <PrivacyNote />
        </div>

        <div className="flex flex-wrap items-baseline justify-between gap-y-3 text-faded-sage">
          <p className="meta">your week</p>
          <p className="meta">gathered by Hale</p>
        </div>
      </section>
    </div>
  );
}

/**
 * A row of the week-spine: the weekday heading + the plans dropped on that day.
 * Shown only for days that actually carry a plan (the page filters empties), so the
 * spine stays scannable rather than seven mostly-empty columns.
 */
function DaySpineRow({ day }: { day: DayColumn }) {
  return (
    <div>
      <span className="eyebrow text-slate-green">{day.weekday}</span>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-3">
        {day.plans.map((plan) => (
          <AuthoredPlanCard key={plan.id} plan={plan} />
        ))}
      </div>
    </div>
  );
}

/**
 * A parent-authored plan card. An OPEN plan carries the soft "done" affordance
 * (CompletePlanButton) and its delete control. A SETTLED plan (completed or
 * past-dated) renders dimmed with no done affordance — it has left the active week
 * and is kept for the record. The teen-name exemption still holds: a parent's own
 * plan about their teen renders in full (policy 2), the tag shows the teen's name.
 */
function AuthoredPlanCard({ plan, settled }: { plan: AuthoredPlanView; settled?: boolean }) {
  const when = plan.scheduledFor ? formatCalendarDate(plan.scheduledFor) : null;
  const done = plan.completedAt !== null;
  return (
    <Card>
      <div className={settled ? 'opacity-60' : undefined}>
        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <ChildTag childId={plan.childId} label={plan.childName} />
            {when ? <span className="meta text-slate-green">{when}</span> : null}
          </div>
          <DeletePlanButton planId={plan.id} label={plan.title} />
        </div>
        <p className="text-lg text-spruce leading-relaxed mt-3" data-hale-pii>
          {plan.title}
        </p>
        {plan.notes ? (
          <p className="meta mt-1 text-slate-green" data-hale-pii>
            {plan.notes}
          </p>
        ) : null}
      </div>
      {!settled ? (
        <div className="mt-4">
          <CompletePlanButton planId={plan.id} alreadyDone={done} label={plan.title} />
        </div>
      ) : null}
    </Card>
  );
}

function PlanItemCard({ item }: { item: PlanChildItem }) {
  // Rule #1 (policy 3): the single locked line for a 13+ teen — the parent sees
  // THAT a plan exists, but no content, no name, and no deep link into it.
  if (item.teenRedacted) {
    return (
      <Card>
        <span className="eyebrow text-slate-green">private</span>
        <p className="text-lg text-spruce leading-relaxed mt-3">{item.what}</p>
      </Card>
    );
  }
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
