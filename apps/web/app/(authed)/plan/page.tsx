import { ArrowRight } from 'lucide-react';
import { AddPlan } from '~/components/hale/add-plan';
import { scopeChildren } from '~/components/hale/child-scope-core';
import {
  AuthoredPlanCard,
  DaySpineRow,
  PlanItemCard,
} from '~/components/hale/plan-cards';
import { PrivacyNote } from '~/components/hale/privacy-note';
import { ShareWeekButton } from '~/components/hale/share-week-button';
import {
  WeekPlanCard,
  WeekPlanToday,
  type WeekPlanKid,
  itemNeedsOk,
} from '~/components/hale/week-plan-card';
import { Card } from '~/components/ui/card';
import { Icon } from '~/components/ui/icon';
import { loadCompanion } from '~/lib/companion/queries';
import { loadFamilyTimezone, loadViewerTeenUnlocks } from '~/lib/dashboard/queries';
import { db } from '~/lib/db';
import { currentFamilyId, loadViewerProfile } from '~/lib/family';
import { receiptsIaEnabled } from '~/lib/flags/receipts-ia';
import { formatCalendarDate } from '~/lib/format/datetime';
import { villageKindLabel } from '~/lib/format/labels';
import { readWeekPlan } from '~/lib/loop/queries';
import { loadAuthoredPlans } from '~/lib/plan/authored';
import { buildPlanSpine, dayKeyIn, groupRoutineByDay, weekWindow } from '~/lib/plan/spine';
import { planChildItems } from '~/lib/plan/week';
import { loadVillage } from '~/lib/village/queries';

/** A clean, minimal section label (Notion/Linear register) — small, muted,
 * spaced above its content. Replaces the editorial label-rail gutters. */
function SectionLabel({ children }: { children: React.ReactNode }) {
  return <p className="eyebrow mb-3 text-ink-3">{children}</p>;
}

export default async function PlanPage() {
  const [village, children, authoredPlans, timeZone, profile] = await Promise.all([
    loadVillage(),
    loadCompanion(),
    loadAuthoredPlans(),
    loadFamilyTimezone(),
    loadViewerProfile(),
  ]);
  const { routine } = village;
  const weekStartDay = profile?.weekStartDay ?? 0;

  // The composed "week ahead" from B1's persisted artifact — the SAME week the Sunday
  // text sends, so the two never disagree. The composer keys every row on Monday, so
  // read this week on the Monday key (weekStartDay=1 here, NOT the family's own
  // week-start preference — a Sunday-start family would otherwise miss its row).
  const familyId = await currentFamilyId();
  const weekStart = weekWindow(new Date(), timeZone, 1, 0).startKey;
  const weekPlan = familyId ? await readWeekPlan(db(), familyId, weekStart) : null;
  const weekPlanNeedsOk = weekPlan ? weekPlan.items.filter(itemNeedsOk).length : 0;
  const addedActivities = village.candidates.filter((c) => c.accepted && !c.teenAttributed);
  const childItems = planChildItems(children, await loadViewerTeenUnlocks());
  const hasRoutine = (routine?.items.length ?? 0) > 0;

  const spine = buildPlanSpine(authoredPlans, new Date(), timeZone, weekStartDay);
  const spineHasDated = spine.days.some((d) => d.plans.length > 0);
  const hasAuthored = spineHasDated || spine.undated.length > 0;

  const hasPlan =
    hasRoutine ||
    childItems.length > 0 ||
    addedActivities.length > 0 ||
    hasAuthored ||
    spine.settled.length > 0;

  const kids = scopeChildren(children);

  // VIL-244 · M9 (D4/D20): under the receipts-room IA this page IS the landing surface,
  // so it leads with a compact Today strip (the demoted feed's job, cut to one day of the
  // SAME artifact) and arranges the week day-first then by kid, oldest first. Item titles
  // are untouched — already teen-gated at compose time — and the who-labels are derived
  // from each child's live stage, so a 13+ child is never named (rule #1).
  const receiptsIa = receiptsIaEnabled();
  const planKids: WeekPlanKid[] = children.map((child) => ({
    id: child.id,
    name: child.name ?? 'your child',
    dateOfBirth: child.dateOfBirth,
    stage: child.stage,
  }));
  const todayKey = dayKeyIn(new Date(), timeZone);

  return (
    <div>
      {/* Title + back-to-Family breadcrumb live in the shell top bar (§3.2). */}

      {/* ── Today — the compact strip that replaces the demoted daily feed ─ */}
      {receiptsIa && weekPlan ? (
        <section className="rise rise-1 mb-8">
          <WeekPlanToday plan={weekPlan} kids={planKids} todayKey={todayKey} />
        </section>
      ) : null}

      {/* ── The week ahead — B1's composed artifact, the Sunday text's twin ─ */}
      {weekPlan ? (
        <section className="rise rise-1 mb-8">
          <SectionLabel>
            the week ahead · gathered by Hale
            {weekPlanNeedsOk > 0
              ? ` · ${weekPlanNeedsOk} ${weekPlanNeedsOk === 1 ? 'needs' : 'need'} your OK`
              : ''}
          </SectionLabel>
          <WeekPlanCard plan={weekPlan} kids={receiptsIa ? planKids : undefined} />
        </section>
      ) : null}

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
                <span className="eyebrow text-ink-2">sometime this week</span>
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
                    <span className="eyebrow text-ink">{kindLabel}</span>
                  ) : null}
                  <p className="text-lg text-ink leading-relaxed mt-3">{candidate.title}</p>
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
            <p className="eyebrow text-ink-3">
              a gentle routine · week of {formatCalendarDate(routine.weekOf)}
            </p>
            <ShareWeekButton />
          </div>
          <div className="space-y-6">
            {groupRoutineByDay(routine.items, weekStartDay).map((strip) => (
              <div key={strip.weekday ?? 'anytime'}>
                <span className="eyebrow text-ink-2">{strip.weekday ?? 'anytime'}</span>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-3">
                  {strip.items.map((item, idx) => {
                    const kindLabel = villageKindLabel(item.kind);
                    return (
                      <Card key={`${strip.weekday ?? 'x'}-${item.kind}-${idx}`} href="/village">
                        {kindLabel ? (
                          <span className="eyebrow text-ink">{kindLabel}</span>
                        ) : null}
                        <div data-hale-pii>
                          <p className="text-lg text-ink leading-relaxed mt-3">{item.title}</p>
                          {item.stageNote ? (
                            <p className="meta mt-1 text-ink-2">{item.stageNote}</p>
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
          <p className="meta mt-4 text-ink-2">
            timing is the standard Canadian schedule — confirm with your provider or local public
            health.
          </p>
        </section>
      ) : null}

      {/* ── Empty state ─────────────────────────────────────────────────── */}
      {!hasPlan ? (
        <section className="rise rise-3 panel-oat px-6 py-12 lg:py-16 text-center">
          <p className="font-display text-[1.5rem] lg:text-[1.875rem] text-ink">
            nothing scheduled yet this week.
          </p>
          <p className="meta mt-4 text-ink-2">
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

        <div className="flex flex-wrap items-baseline justify-between gap-y-3 text-ink-3">
          <p className="meta">your week</p>
          <p className="meta">gathered by Hale</p>
        </div>
      </section>
    </div>
  );
}
