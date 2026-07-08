import type { LogsPage } from '~/lib/companion/logs-view';
import type { ChildCompanionView } from '~/lib/companion/queries';
import type { DocumentView } from '~/lib/docs/documents';
import type { RecentLogView } from '~/lib/companion/recent-logs';
import type { ApprovalView } from '~/lib/dashboard/approvals';
import type { FamilyBasicsView } from '~/lib/dashboard/family-basics';
import type { FamilyMembersView } from '~/lib/dashboard/family-members';
import type { MessageView } from '~/lib/messages/mappers';
import type { PlanChildItem } from '~/lib/plan/week';
import type { NotificationPref, NotificationPrefsView } from '~/lib/settings/notification-prefs';
import type { PushPref } from '~/lib/settings/push-notification-prefs';
import type { PushPrefsView } from '~/lib/push/prefs';
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

/** The More → Saved screen: the family's privately-saved candidates (all saved:true),
 * newest-save-first. Reuses the same teen-redacted view shape as the feed. */
export interface MobileSavedResponse {
  candidates: VillageCandidateView[];
}

export interface MobilePlanResponse {
  addedActivities: VillageCandidateView[];
  routine: RoutineProposalView | null;
  childItems: PlanChildItem[];
  hasPlan: boolean;
}

export interface MobileFamilyResponse {
  members: FamilyMembersView;
  basics: FamilyBasicsView;
  /** The signed-in parent (from THIS session), so the More profile header identifies
   * the viewer — members.primary reads wrong for a co-parent. Name may be null; email
   * always resolves from the account. */
  viewer: { name: string | null; email: string | null };
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

/** The native Diary edit of a logged episode (summary + occurredAt only), reusing
 * the audited updateEpisode lib (family-scoped, rule #1). */
export interface MobileLogEditResponse {
  status: 'edited';
}

/** The native Diary soft-delete of a logged episode, reusing the audited
 * softDeleteEpisode lib (family-scoped, rule #1). */
export interface MobileLogDeleteResponse {
  status: 'deleted';
}

// ── docs vault (GET/POST /api/mobile/docs, /docs/[id]/url, DELETE /docs/[id]) ──
//
// The Docs vault list, already teen-redacted (rule #1) by listDocuments and
// carrying no storage path / URL — a URL is minted per-view through the [id]/url
// route. Bytes never travel in these shapes.

/** The family's live documents, most-recent first (teen-redacted). */
export interface MobileDocsResponse {
  documents: DocumentView[];
}

/** The upload result — the freshly-minted doc id only (no URL; the viewer mints one
 * on demand). */
export interface MobileDocUploadResponse {
  status: 'uploaded';
  id: string;
}

/** A short-TTL signed URL for viewing one document (rule #1: minted per view, never
 * stored). */
export interface MobileDocUrlResponse {
  url: string;
}

/** The soft-delete result (the row stays for the audit trail, rules #6/#9). */
export interface MobileDocDeleteResponse {
  status: 'deleted';
}

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
  /** Optional family / last name (rule #1: sensitive, never required). */
  lastName?: string;
  /** One of the ChildGender values; absent / unknown → 'unspecified' server-side. */
  gender?: string;
  /** Comma-separated free-text interests, e.g. "swimming, music". Optional. */
  interests?: string;
}

export interface AddChildRequest {
  action: 'addChild';
  name: string;
  /** Date-only `YYYY-MM-DD`. */
  dateOfBirth: string;
  lastName?: string;
  gender?: string;
  interests?: string;
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
  | AddChildRequest
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

// ── push notifications (GET + PATCH /api/mobile/settings/notifications) ────────
//
// The two PUSH streams the native app controls (distinct from the daily-brief
// email above): new village picks + health reminders. Both default on (the
// absence of a notification_prefs row), so a GET on a never-touched account
// returns both true.

export interface MobilePushPrefsResponse {
  notifications: PushPrefsView;
}

export interface MobilePushPrefsUpdateRequest {
  pref: PushPref;
  enabled: boolean;
}

export interface MobilePushPrefsUpdateResponse {
  status: 'updated';
}
