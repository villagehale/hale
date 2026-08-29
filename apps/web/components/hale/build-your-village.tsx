import { Sprout } from '~/components/illos';
import { InviteCoParent } from '~/components/hale/invite-coparent';

/**
 * Build-your-village — the growth engine, made a primary, always-visible action
 * (it's how the village compounds). Warmer than the rest of the authed app: a
 * soft apricot band with the sprout illo, the co-parent invite as the headline
 * action. (The week/picks public-share affordances died with routine_proposals —
 * the per-activity share lives on each card.)
 */
export function BuildYourVillage() {
  return (
    <section className="panel panel-apricot-tint">
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-8 lg:gap-x-10 items-start">
        <div className="lg:col-span-5">
          <div className="flex items-start gap-4">
            <Sprout className="w-12 shrink-0" />
            <div>
              <span className="eyebrow text-apricot-deep">build your village</span>
              <h2 className="font-display text-[1.5rem] lg:text-[1.875rem] leading-tight mt-2 text-ink">
                the village grows by invitation.
              </h2>
              <p className="text-ink leading-relaxed mt-3 max-w-md">
                Invite your co-parent and the parents you trust. The more families near you join,
                the more the picks are worth.
              </p>
            </div>
          </div>
        </div>
        <div className="lg:col-span-7 lg:border-l lg:border-rule lg:pl-10">
          <InviteCoParent />
        </div>
      </div>
    </section>
  );
}
