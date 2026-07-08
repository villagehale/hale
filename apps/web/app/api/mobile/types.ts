import type { LogsPage } from '~/lib/companion/logs-view';
import type { ChildCompanionView } from '~/lib/companion/queries';
import type { RecentLogView } from '~/lib/companion/recent-logs';
import type { ApprovalView } from '~/lib/dashboard/approvals';
import type { FamilyBasicsView } from '~/lib/dashboard/family-basics';
import type { FamilyMembersView } from '~/lib/dashboard/family-members';
import type { MessageView } from '~/lib/messages/mappers';
import type { PlanChildItem } from '~/lib/plan/week';
import type { NotificationPref, NotificationPrefsView } from '~/lib/settings/notification-prefs';
import type { RoutineProposalView, VillageCandidateView } from '~/lib/village/mappers';
import type { VillageData } from '~/lib/village/queries';

/**
 * Response shapes for the mobile read API + the quick-log write. Types ONLY — the
 * shapes are the existing page loaders' return types (teen redaction already
 * applied inside those loaders), so the native app and the web pages read the same
 * data. Kept in one place so the app can import the contract without pulling the
 * server route code.
 */

export interface MobileHomeResponse {
  children: ChildCompanionView[];
  village: VillageData;
  members: FamilyMembersView;
  /** The signed-in parent — greet by THIS name, not members.primary (which is the
   * primary-parent slot and reads wrong for a co-parent). */
  viewer: { name: string | null };
}

export interface MobileCompanionResponse {
  children: ChildCompanionView[];
  recentLogs: RecentLogView[];
}

export type MobileVillageResponse = VillageData;

export interface MobilePlanResponse {
  addedActivities: VillageCandidateView[];
  routine: RoutineProposalView | null;
  childItems: PlanChildItem[];
  hasPlan: boolean;
}

export interface MobileFamilyResponse {
  members: FamilyMembersView;
  basics: FamilyBasicsView;
}

export interface MobileApprovalsResponse {
  approvals: ApprovalView[];
}

export interface MobileMessagesResponse {
  messages: MessageView[];
}

export interface MobileLogResponse {
  status: 'logged';
}

/** The native "mark a curated item done" write (a milestone or a health checkup). */
export interface MobileDoneResponse {
  status: 'done';
}

/** A keyset page of the family's quick-logs for the glance-detail sheet — the
 * shared, teen-redacted LogsPage (numerics lifted from payload; never raw payload
 * / notes). */
export type MobileLogsResponse = LogsPage;

// ── family write (POST /api/mobile/family) ────────────────────────────────────
//
// One body shape per family mutation, discriminated by `action`, each delegating
// to the SAME server action the web Family/Settings pages call (edit a child, set
// the household location, edit the parent's display name). The web owns the
// validation + audit (rules #1/#5/#6); the route only dispatches.

export interface EditChildRequest {
  action: 'editChild';
  childId: string;
  name: string;
  /** Date-only `YYYY-MM-DD`. */
  dateOfBirth: string;
}

export interface SetLocationRequest {
  action: 'setLocation';
  country?: string;
  province?: string;
  city?: string;
  postalCode?: string;
}

export interface SetParentNameRequest {
  action: 'setParentName';
  name: string;
}

export type MobileFamilyUpdateRequest =
  | EditChildRequest
  | SetLocationRequest
  | SetParentNameRequest;

export interface MobileFamilyUpdateResponse {
  status: 'updated';
}

// ── settings (GET + POST /api/mobile/settings) ────────────────────────────────

export interface MobileSettingsResponse {
  notifications: NotificationPrefsView;
}

export interface MobileSettingsUpdateRequest {
  pref: NotificationPref;
  enabled: boolean;
}

export interface MobileSettingsUpdateResponse {
  status: 'updated';
}
