import { PLAN_DISPLAY } from '@hale/types';
import { AccountPreferencesCard } from '~/components/hale/account-preferences-card';
import { AccountProfileCard } from '~/components/hale/account-profile-card';
import { Connectors } from '~/components/hale/connectors';
import { DeleteAccountButton } from '~/components/hale/delete-account-button';
import { ExportDataButton } from '~/components/hale/export-data-button';
import { FamilyChildren } from '~/components/hale/family-children';
import { FamilyPlan } from '~/components/hale/family-plan';
import { InviteCoParent } from '~/components/hale/invite-coparent';
import { NotificationPrefs } from '~/components/hale/notification-prefs';
import { PlanSummaryCard } from '~/components/hale/plan-summary-card';
import { PrivacyNote } from '~/components/hale/privacy-note';
import { SettingsHub } from '~/components/hale/settings-hub';
import type { SettingsSectionId } from '~/components/hale/settings-sections';
import { SharedLinks } from '~/components/hale/shared-links';
import { APP_VERSION } from '~/lib/app-version';
import { signOutAction } from '~/lib/auth-actions';
import { authConfigured } from '~/lib/auth-config';
import { loadFamilyBasics, loadFamilyMembers } from '~/lib/dashboard/queries';
import { loadViewerProfile } from '~/lib/family';
import { loadFamilyConnectors } from '~/lib/integrations/load';
import { loadPushNotificationPrefs } from '~/lib/settings/push-notification-prefs';
import { isStripeCheckoutConfigured } from '~/lib/webhooks/stripe-billing';

/** A section label in the app's quiet register (matches /family/members, /plan). */
function SectionLabel({ children }: { children: React.ReactNode }) {
  return <p className="eyebrow mb-4 text-faded-sage">{children}</p>;
}

/**
 * Settings hub (design handoff §4.7): a 216px left sub-nav switching six sections —
 * Account / Family & children / Plan & billing / Notifications / Connected apps /
 * Support & about — replacing the old seven-anchor scroll page. Every section shows
 * real data or an honest empty state; nothing the store can't back is invented
 * (rule #1). The old anchor deep links (#billing, #privacy, …) still resolve to
 * their new section via SettingsHub (settings-sections). Preferences + Appearance
 * fold into Account; Privacy & data (PIPEDA export/erase) folds into Support & about.
 *
 * The page title + subtitle live in the shell top bar (design handoff §3.2).
 */
export default async function SettingsPage() {
  const [profile, basics, members, connections, pushPrefs] = await Promise.all([
    loadViewerProfile(),
    loadFamilyBasics(),
    loadFamilyMembers(),
    loadFamilyConnectors(),
    loadPushNotificationPrefs(),
  ]);

  const planName = PLAN_DISPLAY[basics.planTier].name;
  const canSignOut = authConfigured();

  const sections: Record<SettingsSectionId, React.ReactNode> = {
    // ── Account ──────────────────────────────────────────────────────────
    account: (
      <div className="flex flex-col gap-y-10">
        <div>
          <SectionLabel>profile</SectionLabel>
          {profile ? (
            <AccountProfileCard profile={profile} planLabel={`${planName} plan`} />
          ) : (
            <p className="text-spruce leading-relaxed max-w-md">
              Sign in to see and edit your account details.
            </p>
          )}
        </div>

        <div>
          <SectionLabel>sign-in &amp; security</SectionLabel>
          <div className="panel-oat px-6 py-5">
            <p className="font-medium text-spruce">Magic link</p>
            <p className="meta mt-1 max-w-md leading-relaxed">
              We email you a secure sign-in link — there&rsquo;s no password to remember, and none
              to reset.
            </p>
          </div>
        </div>

        {profile ? (
          <div>
            <SectionLabel>preferences</SectionLabel>
            <AccountPreferencesCard profile={profile} />
          </div>
        ) : null}
      </div>
    ),

    // ── Family & children ────────────────────────────────────────────────
    family: (
      <div className="flex flex-col gap-y-10">
        <div>
          <SectionLabel>parents &amp; caregivers</SectionLabel>
          <div className="flex flex-col gap-y-6">
            {members.primary ? (
              <div>
                <p className="meta">you · primary parent</p>
                <p className="font-display text-[1.25rem] mt-1" data-hale-pii>
                  {members.primary.name ?? members.primary.email}
                </p>
                <p className="meta mt-1" data-hale-pii>
                  {members.primary.email}
                </p>
              </div>
            ) : null}
            {members.coParent ? (
              <div>
                <p className="meta">co-parent · full access</p>
                <p className="font-display text-[1.25rem] mt-1" data-hale-pii>
                  {members.coParent.name ?? members.coParent.email}
                </p>
                <p className="meta mt-1" data-hale-pii>
                  {members.coParent.email}
                </p>
              </div>
            ) : (
              <InviteCoParent />
            )}
          </div>
        </div>

        <div>
          <SectionLabel>children</SectionLabel>
          <FamilyChildren kids={basics.children} />
        </div>
      </div>
    ),

    // ── Plan & billing ───────────────────────────────────────────────────
    plan: (
      <div className="flex flex-col gap-y-8">
        <PlanSummaryCard planTier={basics.planTier} />
        <FamilyPlan planTier={basics.planTier} billingConfigured={isStripeCheckoutConfigured()} />
      </div>
    ),

    // ── Notifications ────────────────────────────────────────────────────
    notif: (
      <div>
        <SectionLabel>push notifications</SectionLabel>
        <NotificationPrefs result={pushPrefs} />
      </div>
    ),

    // ── Connected apps ───────────────────────────────────────────────────
    apps: (
      <div>
        <SectionLabel>connected accounts</SectionLabel>
        <Connectors connections={connections} />
      </div>
    ),

    // ── Support & about ──────────────────────────────────────────────────
    about: (
      <div className="flex flex-col gap-y-10">
        <div>
          <SectionLabel>help &amp; about</SectionLabel>
          <ul className="flex flex-col divide-y divide-rule border-y border-rule">
            <li>
              <a className="settings-link-row" href="mailto:privacy@villagehale.com">
                Help &amp; support
              </a>
            </li>
            <li>
              <a className="settings-link-row" href="/terms">
                Terms of Service
              </a>
            </li>
            <li>
              <a className="settings-link-row" href="/privacy">
                Privacy Policy
              </a>
            </li>
          </ul>
          <p className="meta mt-4">
            Hale for Web · Version {APP_VERSION} · Hawaiian for &ldquo;home&rdquo;.
          </p>
        </div>

        <div className="flex flex-col gap-y-8">
          <SectionLabel>your privacy &amp; data</SectionLabel>
          <div className="panel-oat px-6 py-5 flex flex-wrap items-center gap-x-6 gap-y-2">
            {[
              'teen content is private from parents by default',
              'nothing is shared with a third party unless you connect one',
            ].map((note) => (
              <span key={note} className="meta">
                {note}
              </span>
            ))}
            <PrivacyNote />
          </div>

          <div className="flex flex-col gap-y-3">
            <span className="eyebrow text-spruce">your data</span>
            <p className="text-spruce leading-relaxed max-w-md">
              Download a structured copy of everything Hale holds about your family — your history,
              your children, and your settings. Teen content follows the same privacy rules you
              already see.
            </p>
            <ExportDataButton />
          </div>

          <div className="flex flex-col gap-y-3 border-t border-rule pt-8">
            <span className="eyebrow text-spruce">links you have shared</span>
            <p className="text-spruce leading-relaxed max-w-md">
              Public links you&rsquo;ve created for a week plan or a local pick. Revoke one any time
              — the page it points to goes quiet immediately.
            </p>
            <SharedLinks />
          </div>

          <div className="flex flex-col gap-y-3 border-t border-rule pt-8">
            <span className="eyebrow text-berry">delete account</span>
            <DeleteAccountButton />
          </div>
        </div>

        {canSignOut ? (
          <form action={signOutAction} className="border-t border-rule pt-8">
            <button type="submit" className="btn-secondary">
              Sign out
            </button>
          </form>
        ) : null}
      </div>
    ),
  };

  return <SettingsHub sections={sections} />;
}
