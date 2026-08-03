import { ArrowRight, Shield } from 'lucide-react';
import { ChildTag } from '~/components/hale/child-tag';
import { CompletePlanButton } from '~/components/hale/complete-plan-button';
import { DeletePlanButton } from '~/components/hale/delete-plan-button';
import { Card } from '~/components/ui/card';
import { Icon } from '~/components/ui/icon';
import { formatCalendarDate } from '~/lib/format/datetime';
import type { AuthoredPlanView } from '~/lib/plan/authored';
import type { DayColumn } from '~/lib/plan/spine';
import type { PlanChildItem } from '~/lib/plan/week';

/**
 * The week's card shapes — the parent's own written plan, and the "coming up"
 * item Hale derived for a child. Extracted from the page so the surface can be
 * rendered from literal props (design QA without a database); presentation only,
 * every control is the shipping button it already was.
 */

/**
 * A row of the week-spine: the weekday heading + the plans dropped on that day.
 * Shown only for days that actually carry a plan (the page filters empties), so the
 * spine stays scannable rather than seven mostly-empty columns.
 */
export function DaySpineRow({ day }: { day: DayColumn }) {
  return (
    <div>
      <span className="eyebrow text-ink-2">{day.weekday}</span>
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
export function AuthoredPlanCard({
  plan,
  settled,
}: {
  plan: AuthoredPlanView;
  settled?: boolean;
}) {
  const when = plan.scheduledFor ? formatCalendarDate(plan.scheduledFor) : null;
  const done = plan.completedAt !== null;
  // The done/remove controls read alike on every card, so the title joins their
  // accessible name BY REFERENCE (VIL-276 — an `aria-label` copy of the title would
  // reach a session replay verbatim). Derived from the plan id, so it is unique per
  // card and stable across renders without a hook, which this server component
  // could not call anyway.
  const titleId = `plan-${plan.id}-title`;
  return (
    <Card>
      <div className={settled ? 'opacity-60' : undefined}>
        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <ChildTag childId={plan.childId} label={plan.childName} />
            {/* "Settled" was carried by a 60% dim alone — appearance as the sole
              * carrier of a state (a11y rule), and invisible to anyone reading the
              * card on its own. The chip says it; the dim stays as reinforcement. */}
            {settled ? <span className="pill pill-tint chip-gray">settled</span> : null}
            {when ? <span className="meta text-ink-2">{when}</span> : null}
          </div>
          <DeletePlanButton planId={plan.id} labelledBy={titleId} />
        </div>
        <p id={titleId} className="text-lg text-ink leading-relaxed mt-3" data-hale-pii>
          {plan.title}
        </p>
        {plan.notes ? (
          <p className="meta mt-1 text-ink-2" data-hale-pii>
            {plan.notes}
          </p>
        ) : null}
      </div>
      {!settled ? (
        <div className="mt-4">
          <CompletePlanButton planId={plan.id} alreadyDone={done} labelledBy={titleId} />
        </div>
      ) : null}
    </Card>
  );
}

export function PlanItemCard({ item }: { item: PlanChildItem }) {
  // Rule #1 (policy 3): the single locked line for a 13+ teen — the parent sees
  // THAT a plan exists, but no content, no name, and no deep link into it.
  if (item.teenRedacted) {
    return (
      <Card>
        {/* Shore's privacy mark — the same shield + terracotta wash Approvals and the
          * trail use for the same fact, so "held back for a teen" reads as one thing
          * across the receipts path. */}
        <span className="pill pill-berry inline-flex items-center gap-1.5">
          <Shield size={13} strokeWidth={1.8} aria-hidden="true" />
          private
        </span>
        <p className="text-lg text-ink leading-relaxed mt-3">{item.what}</p>
      </Card>
    );
  }
  return (
    <Card href="/companion">
      <span className="eyebrow text-ink">{item.kindLabel}</span>
      <p className="text-lg text-ink leading-relaxed mt-3" data-hale-pii>
        {item.what}
      </p>
      <p className="meta mt-1 text-ink-2">
        <span data-hale-pii>{item.childName}</span> · {item.when}
      </p>
      <span className="meta mt-4 inline-flex items-center gap-1.5 text-apricot-deep">
        open in companion
        <Icon as={ArrowRight} size={14} />
      </span>
    </Card>
  );
}
