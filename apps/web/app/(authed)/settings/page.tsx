import {
  Download,
  KeyRound,
  Link2,
  Mail,
  MapPin,
  Phone,
  ScrollText,
  ShieldCheck,
  SunMoon,
  UsersRound,
} from 'lucide-react';
import Link from 'next/link';
import { AccountPreferencesCard } from '~/components/hale/account-preferences-card';
import { ConnectedAssistants } from '~/components/hale/connected-assistants';
import { ConnectionChannelsCard } from '~/components/hale/connection-channels-card';
import { ConnectionSources } from '~/components/hale/connection-sources';
import { ConsentRecordsList } from '~/components/hale/consent-records-list';
import {
  DeleteAccountButton,
  type DeleteAccountRole,
} from '~/components/hale/delete-account-button';
import { ExportDataButton } from '~/components/hale/export-data-button';
import { FamilyParent } from '~/components/hale/family-parent';
import { FamilyPlan } from '~/components/hale/family-plan';
import { LoopPrefs } from '~/components/hale/loop-prefs';
import { PlanSummaryCard } from '~/components/hale/plan-summary-card';
import { SettingsCard, SettingsRow, SettingsSection } from '~/components/hale/settings-card';
import { SettingsColumn } from '~/components/hale/settings-column';
import { SettingsRowReveal } from '~/components/hale/settings-row-reveal';
import { SharedLinks } from '~/components/hale/shared-links';
import { TextNotifications } from '~/components/hale/text-notifications';
import { ThemeToggle } from '~/components/hale/theme-toggle';
import { Icon } from '~/components/ui/icon';
import { APP_VERSION } from '~/lib/app-version';
import { signOutAction } from '~/lib/auth-actions';
import { authConfigured } from '~/lib/auth-config';
import { loadSmsChannel } from '~/lib/channels/sms-consent';
import { listConsentRecordsForViewer } from '~/lib/consent-records';
import { loadFamilyBasics, loadFamilyMembers } from '~/lib/dashboard/queries';
import { db } from '~/lib/db';
import { currentFamilyId, currentUserId, listSeatsForUser, loadViewerProfile } from '~/lib/family';
import { loadFamilyConnectors } from '~/lib/integrations/load';
import { PRIVACY_URL, TERMS_URL } from '~/lib/legal-links';
import { listMcpConnectionsForUser } from '~/lib/mcp/oauth-store';
import { loadLoopNotificationPrefs } from '~/lib/settings/loop-prefs';
import { isStripeCheckoutConfigured } from '~/lib/webhooks/stripe-billing';

/**
 * Settings — one centered scrolling column of flat cards (Instinct-adapted refresh,
 * replacing the 216px sub-nav hub). Sections: Account / Notifications / Plan /
 * Connected apps / Trust / (danger card) / About; settings-sections keeps every old
 * deep link resolving to a live anchor. Every row shows real data or an honest empty
 * state; nothing the store can't back is invented (rule #1). The family editor lives
 * at /family — Account carries the pointer row.
 *
 * The page title + subtitle live in the shell top bar (design handoff §3.2).
 */
export default async function SettingsPage() {
  const database = db();
  const [profile, basics, members, connections, loopPrefs, smsChannel, familyId, userId] =
    await Promise.all([
      loadViewerProfile(),
      loadFamilyBasics(),
      loadFamilyMembers(),
      loadFamilyConnectors(),
      loadLoopNotificationPrefs(),
      loadSmsChannel(),
      currentFamilyId(database),
      currentUserId(database),
    ]);
  const [assistantConnections, consents, seats] = await Promise.all([
    familyId && userId
      ? listMcpConnectionsForUser(database, familyId, userId)
      : Promise.resolve([]),
    userId ? listConsentRecordsForViewer(database, userId) : Promise.resolve([]),
    userId ? listSeatsForUser(userId, database) : Promise.resolve([]),
  ]);
  // The danger card asks for consent to an ACT, and which act it is depends on the seat
  // (VIL-355): a co-parent's request is a DEPARTURE, not the family's erasure, so only
  // that seat gets the leaving words. A named caregiver has no erasure of its own and is
  // told so instead of being offered a button the route would refuse. An unresolved
  // viewer keeps today's family wording — unchanged behaviour, not a new promise.
  //
  // MORE THAN ONE SEAT IS ITS OWN ANSWER, and it comes first. `familyId` is resolved by
  // a `limit(1)` with no ORDER BY, so a separated parent's role here is whichever
  // household the heap handed back — while the route enumerates the seats and 409s
  // rather than choosing. Asking them in the household's own words and only then
  // admitting Hale cannot tell which household they meant is the promise being made at
  // the wrong moment, so the question is put before the click instead of after it.
  const viewerRole = seats.find((seat) => seat.familyId === familyId)?.role ?? null;
  const viewerIsCoParent = seats.length === 1 && viewerRole === 'co_parent';
  const deleteRole: DeleteAccountRole =
    seats.length > 1
      ? 'ambiguous'
      : viewerIsCoParent
        ? 'co_parent'
        : viewerRole === null || viewerRole === 'primary_parent'
          ? 'primary_parent'
          : 'scoped';
  // The card and the button say the SAME thing about the same act, because a heading
  // that promises an erasure over a button that performs a departure is the defect this
  // exists to close.
  const dangerCard =
    deleteRole === 'co_parent'
      ? {
          label: 'Leave this family',
          body: (
            <>
              You can leave this family at any time. Hale stops texting you about them straight away
              and disconnects everything you connected. The family’s own record — the children, the
              history — belongs to the household and stays with it. To ask what Hale still holds for
              you, email{' '}
              <a className="link" href="mailto:privacy@villagehale.com">
                privacy@villagehale.com
              </a>
              .
            </>
          ),
        }
      : deleteRole === 'scoped' || deleteRole === 'ambiguous'
        ? { label: 'Your data', body: null }
        : {
            label: 'Delete everything',
            body: (
              <>
                This removes everything Hale holds about your family — your children, your history,
                and every connected service. Deletion begins after a 7-day grace window; you’ll see
                the exact date when you confirm. There’s no in-app undo: to stop it during those 7
                days, reply to any Hale text or email{' '}
                <a className="link" href="mailto:privacy@villagehale.com">
                  privacy@villagehale.com
                </a>
                .
              </>
            ),
          };

  const canSignOut = authConfigured();

  // ── Derived row values (never fabricated — every line traces to a load) ──
  const phoneValue =
    smsChannel.status !== 'ready'
      ? 'Sign in to link a number'
      : smsChannel.channel.enrolled && smsChannel.channel.maskedPhone
        ? `${smsChannel.channel.maskedPhone} · the number you text Hale from`
        : smsChannel.senderConfigured
          ? 'No number linked yet'
          : 'Texting isn’t switched on yet';
  const phoneEnrolled = smsChannel.status === 'ready' && smsChannel.channel.enrolled;

  // The sign-in row is DERIVED from the account's real identity, never hardcoded:
  // an email account signs in by magic link; a phone-claim account has no email.
  const signInValue = profile?.email
    ? `Magic link to ${profile.email}`
    : 'You claim your number to sign in';

  const childCount = basics.children.length;
  const familyValue = `${childCount} ${childCount === 1 ? 'child' : 'children'} · ${
    members.coParent ? 'co-parent joined' : 'co-parent not yet'
  }`;

  return (
    <SettingsColumn>
      {/* ── Account ─────────────────────────────────────────────────────── */}
      <SettingsSection
        id="account"
        label="Account"
        explainer="How you reach Hale, and how Hale reaches you."
      >
        {profile ? (
          <SettingsCard>
            <SettingsRowReveal
              icon="user"
              label="Name"
              value={profile.name?.trim() || 'No name yet'}
              pii
              actionLabel="Change"
            >
              <FamilyParent name={profile.name} email={profile.email} />
            </SettingsRowReveal>

            {smsChannel.status === 'ready' ? (
              <SettingsRowReveal
                icon="phone"
                label="Phone"
                value={phoneValue}
                pii={phoneEnrolled}
                actionLabel={phoneEnrolled ? 'Change' : 'Link'}
              >
                <TextNotifications result={smsChannel} />
              </SettingsRowReveal>
            ) : (
              <SettingsRow icon={Phone} label="Phone" value={phoneValue} />
            )}

            <SettingsRow
              icon={Mail}
              label="Email"
              value={profile.email ?? 'No email on file — you sign in with your number'}
              pii={profile.email !== null}
            />

            <SettingsRow icon={KeyRound} label="Sign-in" value={signInValue} pii />

            <SettingsRow icon={SunMoon} label="Appearance" action={<ThemeToggle />} />

            <SettingsRowReveal
              icon="ruler"
              label="Display preferences"
              value="Units and the first day of your week"
              actionLabel="Change"
            >
              <AccountPreferencesCard profile={profile} />
            </SettingsRowReveal>

            <SettingsRow
              icon={UsersRound}
              label="Family & children"
              value={familyValue}
              action={
                <Link href="/family" className="btn-secondary">
                  Manage
                </Link>
              }
            />
          </SettingsCard>
        ) : (
          <p className="text-spruce leading-relaxed max-w-md">
            Sign in to see and edit your account details.
          </p>
        )}
      </SettingsSection>

      {/* ── Notifications ───────────────────────────────────────────────── */}
      <SettingsSection
        id="notif"
        label="Notifications"
        explainer="What Hale is allowed to send you, and where."
      >
        <SettingsCard>
          <div className="py-4">
            <p className="eyebrow text-faded-sage mb-4">the sunday loop</p>
            <LoopPrefs result={loopPrefs} />
          </div>
        </SettingsCard>
      </SettingsSection>

      {/* ── Plan ────────────────────────────────────────────────────────── */}
      <SettingsSection id="plan" label="Plan" explainer="What your family is on, plainly.">
        <div className="flex flex-col gap-y-6">
          <PlanSummaryCard planTier={basics.planTier} />
          <FamilyPlan planTier={basics.planTier} billingConfigured={isStripeCheckoutConfigured()} />
        </div>
      </SettingsSection>

      {/* ── Connections ─────────────────────────────────────────────────── */}
      <SettingsSection
        id="apps"
        label="Connections"
        explainer="How Hale reaches you, what it can read, and the assistants you’ve allowed in."
      >
        <div className="flex flex-col gap-y-8">
          <div>
            <p className="eyebrow text-faded-sage mb-4">how hale reaches you</p>
            <ConnectionChannelsCard sms={smsChannel} email={profile?.email ?? null} />
          </div>
          <div>
            <p className="eyebrow text-faded-sage mb-4">what hale can read</p>
            <ConnectionSources connections={connections} />
          </div>
          <div>
            <p className="eyebrow text-faded-sage mb-4">assistants</p>
            <ConnectedAssistants connections={assistantConnections} />
          </div>
        </div>
      </SettingsSection>

      {/* ── Trust ───────────────────────────────────────────────────────── */}
      <SettingsSection
        id="trust"
        label="Trust"
        explainer="What Hale holds, where it lives, and your controls."
      >
        <SettingsCard>
          {/* Two static statements — decided facts, not toggles (rule #1 posture). */}
          <SettingsRow
            icon={MapPin}
            label="Your family’s data stays in Canada"
            value="Stored in Toronto, and it doesn’t leave."
          />
          <SettingsRow
            icon={ShieldCheck}
            label="Your conversations are never used to train AI models"
            value="Not by Hale, and not by the models Hale uses."
          />

          <SettingsRow
            icon={Download}
            label="Export my data"
            value="A structured copy of everything Hale holds about your family."
            action={<ExportDataButton />}
          />

          <details className="settings-flat-details">
            <summary className="settings-flat-summary">
              <span className="settings-flat-icon">
                <Icon as={ScrollText} size={18} />
              </span>
              <span className="settings-flat-text">
                <span className="settings-flat-label">Consent records</span>
                <span className="settings-flat-value">
                  Every yes and no you’ve given, on your own ledger.
                </span>
              </span>
              <span className="btn-secondary settings-flat-cue" aria-hidden="true">
                View
              </span>
            </summary>
            <div className="settings-flat-panel">
              <ConsentRecordsList records={consents} />
            </div>
          </details>

          <div>
            <SettingsRow
              icon={Link2}
              label="Links you’ve shared"
              value="Public links for a week plan or a local pick — revoke any time."
            />
            <div className="settings-flat-panel">
              <SharedLinks />
            </div>
          </div>
        </SettingsCard>
      </SettingsSection>

      {/* ── Danger ──────────────────────────────────────────────────────── */}
      <section aria-label={dangerCard.label}>
        <SettingsCard>
          <div className="py-4">
            <p className="eyebrow text-berry">{dangerCard.label}</p>
            {dangerCard.body ? (
              <p className="text-spruce leading-relaxed max-w-md mt-3">{dangerCard.body}</p>
            ) : null}
            <div className="mt-4">
              <DeleteAccountButton role={deleteRole} />
            </div>
          </div>
        </SettingsCard>
      </section>

      {/* ── About ───────────────────────────────────────────────────────── */}
      <SettingsSection id="about" label="About" explainer="Help, the fine print, and the door.">
        <div className="flex flex-col gap-y-6">
          <ul className="flex flex-col divide-y divide-rule border-y border-rule">
            <li>
              <a className="settings-link-row" href="mailto:privacy@villagehale.com">
                Help &amp; support
              </a>
            </li>
            <li>
              <a className="settings-link-row" href={TERMS_URL}>
                Terms of Service
              </a>
            </li>
            <li>
              <a className="settings-link-row" href={PRIVACY_URL}>
                Privacy Policy
              </a>
            </li>
          </ul>
          <p className="meta">Hale for Web · Version {APP_VERSION} · Hawaiian for &ldquo;home&rdquo;.</p>
          {canSignOut ? (
            <form action={signOutAction}>
              <button type="submit" className="btn-secondary">
                Sign out
              </button>
            </form>
          ) : null}
        </div>
      </SettingsSection>
    </SettingsColumn>
  );
}
