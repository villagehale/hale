import { AcceptButton } from '~/components/hale/accept-button';
import { Card } from '~/components/ui/card';

export interface AcceptActivity {
  id: string;
  kind: string;
  title: string;
  summary: string;
  acceptHref: string;
}

/**
 * A "near you this week" card on Home whose primary action is the real
 * add-to-plan: AcceptButton POSTs the candidate into the same accept pipeline as
 * the Village page (so it audits + re-enters the spine). The card itself stays
 * static (not a whole-card link) so it never lies about being clickable — the
 * button is the action.
 */
export function AcceptActivityCard({ activity }: { activity: AcceptActivity }) {
  return (
    <Card>
      <span className="eyebrow text-spruce">{activity.kind}</span>
      <p className="font-display text-[1.25rem] mt-2 leading-snug">{activity.title}</p>
      <p className="meta mt-3 text-slate-green">{activity.summary}</p>
      <div className="mt-4">
        <AcceptButton href={activity.acceptHref} />
      </div>
    </Card>
  );
}
