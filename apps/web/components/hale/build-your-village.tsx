import { Sprout } from '~/components/illos';
import { InviteCoParent } from '~/components/hale/invite-coparent';
import { ShareButton } from '~/components/hale/share-button';
import { ShareWeekButton } from '~/components/hale/share-week-button';

/**
 * Build-your-village — the growth engine, made a primary, always-visible action
 * (it's how the village compounds). Warmer than the rest of the authed app: a
 * soft apricot band with the sprout illo, the co-parent invite as the headline
 * action, plus the two public-share affordances (this week's plan, and the
 * endorsed picks shortlist). Each share mints a privacy-safe public link and
 * writes an audit row server-side (rule #6).
 *
 * `nothingToShare` disables the week/picks share when there's no plan to anchor a
 * token, so a parent always sees why rather than hitting a dead button.
 */
export function BuildYourVillage({ nothingToShare }: { nothingToShare: boolean }) {
  return (
    <section className="panel panel-apricot-tint">
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-8 lg:gap-x-10 items-start">
        <div className="lg:col-span-5">
          <div className="flex items-start gap-4">
            <Sprout className="w-12 shrink-0" />
            <div>
              <span className="eyebrow text-apricot-deep">build your village</span>
              <h2 className="font-display text-[1.5rem] lg:text-[1.875rem] leading-tight mt-2 text-spruce">
                the village grows by invitation.
              </h2>
              <p className="text-spruce leading-relaxed mt-3 max-w-md">
                Invite your co-parent and the parents you trust. The more families near you join,
                the more the picks are worth.
              </p>
            </div>
          </div>
          <div className="mt-6 flex flex-wrap items-start gap-x-6 gap-y-4">
            {nothingToShare ? (
              <ShareWeekButton nothingToShare />
            ) : (
              <>
                <ShareButton
                  endpoint="/api/village/share"
                  label="share this week"
                  shareTitle="this week's plan on Hale"
                />
                <ShareButton
                  endpoint="/api/village/picks/share"
                  label="share my picks"
                  shareTitle="our village picks on Hale"
                  variant="ghost"
                />
              </>
            )}
          </div>
        </div>
        <div className="lg:col-span-7 lg:border-l lg:border-rule lg:pl-10">
          <InviteCoParent />
        </div>
      </div>
    </section>
  );
}
