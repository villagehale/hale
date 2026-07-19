import type { LogsPage } from '~/lib/companion/logs-view';
import type { ChildCompanionView } from '~/lib/companion/queries';
import type { HomeStats } from '~/lib/home/aggregates';
import type { DocumentView } from '~/lib/docs/documents';
import type { RecentLogView } from '~/lib/companion/recent-logs';
import type { ApprovalView } from '~/lib/dashboard/approvals';
import type { HistoryView } from '~/lib/dashboard/history';
import type { FamilyBasicsView } from '~/lib/dashboard/family-basics';
import type { FamilyMembersView } from '~/lib/dashboard/family-members';
import type { MessageView } from '~/lib/messages/mappers';
import type { ScopeChild } from '~/components/hale/child-scope-core';
import type { AuthoredPlanView } from '~/lib/plan/authored';
import type { PlanChildItem } from '~/lib/plan/week';
import type { PlanCatalogView } from '~/lib/plan/catalog';
import type { FamilyExportDocument } from '~/lib/rights/export';
import type { NotificationPref, NotificationPrefsView } from '~/lib/settings/notification-prefs';
import type { PushPref } from '~/lib/settings/push-notification-prefs';
import type { PushPrefsView } from '~/lib/push/prefs';
import type { ShareLinkKind, SharedLink } from '~/lib/village/share-revoke';
import type { CuratedResourceView } from '~/lib/village/curated-resources';
import type { RoutineProposalView, VillageCandidateView } from '~/lib/village/mappers';
import type { VillageData } from '~/lib/village/queries';
import type { UnitSystem } from '@hale/types';

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
  /** The Home stat-row counts (this week's logs, upcoming health items, saved
   * places) — counts only, teen-redacted at the source (rule #1). */
  stats: HomeStats;
  /** The signed-in parent — greet by THIS name, not members.primary (which is the
   * primary-parent slot and reads wrong for a co-parent). */
  viewer: { name: string | null };
}

export interface MobileCompanionResponse {
  children: ChildCompanionView[];
  recentLogs: RecentLogView[];
}

/** The Village tab: the family's candidates + routine (VillageData), plus the
 * curated Resources rail. `resources` is additive + optional: it is present only on
 * the standing feed read (a directory is not season-scoped, so a season search
 * omits it), and an older client that ignores it still reads candidates/routine. */
export interface MobileVillageResponse extends VillageData {
  resources?: CuratedResourceView[];
}

/** The More → Saved screen: the family's privately-saved candidates (all saved:true),
 * newest-save-first. Reuses the same teen-redacted view shape as the feed. */
export interface MobileSavedResponse {
  candidates: VillageCandidateView[];
}

/** GET /api/mobile/village/:id — one candidate for the native pushed Activity route,
 * resolved by id and teen-redacted at the mapper (rule #1). `candidate` is null when
 * the id is unknown or belongs to another family (indistinguishable — never reveals a
 * redacted card's existence), so the route lands on its honest empty state. */
export interface MobileVillageCandidateResponse {
  candidate: VillageCandidateView | null;
}

export interface MobilePlanResponse {
  /** Parent-authored plans, chronological (soonest scheduledFor first), the same
   * session-scoped, teen-exempt view the web /plan page leads with. The client folds
   * them into a Mon–Sun spine using `timeZone`. */
  authoredPlans: AuthoredPlanView[];
  /** The family's IANA zone, so the client builds the SAME current-week spine the
   * web page does (a parent at 11pm ET is on today, not the server's UTC tomorrow). */
  timeZone: string;
  /** The signed-in parent's chosen first day of the week (0=Sunday, 1=Monday), so the
   * client orders the same spine columns the web page does. Delivered here so the plan
   * screen gets it alongside plan data in one fetch. */
  weekStartDay: number;
  /** The family's children as scope options for the AddPlan "who is this for" picker
   * (whole-family + each child), the same scopeChildren derivation the web page uses.
   * A teen's name is teen-safe here — a scope chip disambiguates WHICH child (policy 1). */
  scopeChildren: ScopeChild[];
  addedActivities: VillageCandidateView[];
  routine: RoutineProposalView | null;
  childItems: PlanChildItem[];
  hasPlan: boolean;
}

// ── plan write (POST /api/mobile/plan) ────────────────────────────────────────
//
// One body shape per parent-authored plan mutation, discriminated by `action`, each
// delegating to the SAME server action the web Plan page calls (createPlan /
// completePlan / deletePlan). The web owns validation, family-scoping (rule #1), and
// the audit_log write (rule #6); the route only dispatches.

export interface CreatePlanRequest {
  action: 'create';
  title: string;
  /** Optional free-text note, or null. */
  notes: string | null;
  /** ISO datetime the plan is scheduled for, or null for an undated plan. */
  scheduledFor: string | null;
  /** A child in the caller's family, or null for a whole-family plan. */
  childId: string | null;
}

export interface CompletePlanRequest {
  action: 'complete';
  planId: string;
}

export interface DeletePlanRequest {
  action: 'delete';
  planId: string;
}

export type MobilePlanUpdateRequest = CreatePlanRequest | CompletePlanRequest | DeletePlanRequest;

export interface MobilePlanUpdateResponse {
  status: 'created' | 'completed' | 'deleted';
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

/** The Approvals → History segment: the family's RESOLVED actions (executed /
 * declined / reverted / held), newest first. Teen-redacted at the source, reusing
 * the live card's intent label (rule #1). */
export interface MobileApprovalsHistoryResponse {
  history: HistoryView[];
}

export interface MobileMessagesResponse {
  messages: MessageView[];
}

/** The native Plan surface (More → Plan & billing): the family's current tier + the
 * plan catalog from the @hale/types source of truth. Informational only — no
 * billing/checkout is wired. */
export interface MobilePlanTiersResponse {
  catalog: PlanCatalogView;
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
  /** Natal sex for the WHO growth comparison: 'male' | 'female'; anything else /
   * "prefer not to say" → null server-side. Distinct from gender (rule #1). */
  biologicalSex?: string;
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

// ── preferences (GET + POST /api/mobile/preferences) ──────────────────────────
//
// The parent's display preferences off their `users` row: `units` (metric/imperial —
// a DISPLAY choice; storage is always metric) and `weekStartDay` (0=Sun, 1=Mon). The
// route delegates the write to the SAME shared lib the web card calls, so the audit
// row (rule #6) is single-sourced.

export interface MobilePreferencesResponse {
  units: UnitSystem;
  weekStartDay: number;
}

export interface MobilePreferencesUpdateRequest {
  units: UnitSystem;
  weekStartDay: number;
}

export interface MobilePreferencesUpdateResponse {
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

// ── connectors (GET /api/mobile/integrations/connect-url) ─────────────────────
//
// The native app can't use the cookie-authed web connect route, so this Bearer
// route returns the Google consent URL to open in a browser. The URL carries the
// SAME signed state (familyId+userId+provider, surface=mobile), so the shared
// callback needs no browser session — it redirects to the public /connected page.

/** The Google consent URL to open in a browser for a connector connect flow. */
export interface MobileConnectUrlResponse {
  url: string;
}

// ── connectors state (GET /api/mobile/integrations) + disconnect ──────────────
//
// The family's connector state for the native "Connected accounts" UI: whether each
// read-only Google connector is linked. The route normalizes the raw
// integration_status into an honest UI status and NEVER serializes tokens or scopes
// (rule #1) — connection plumbing only, nothing about mailbox/calendar content.

export type ConnectorProviderSlug = 'gcal' | 'gmail' | 'gdrive';

/** The honest, UI-facing connection status — 'connected' only when truly active;
 * 'error' means "needs reconnecting"; 'not_connected' otherwise (fail closed). */
export type IntegrationStatus = 'connected' | 'not_connected' | 'error';

export interface ConnectorState {
  provider: ConnectorProviderSlug;
  status: IntegrationStatus;
  /** ISO instant the connection was made — omitted when never linked. Activity
   * signal only, never content. */
  connectedAt?: string;
}

export interface MobileIntegrationsResponse {
  connectors: ConnectorState[];
}

/** The disconnect result (the connection is revoked + audited server-side, rule #6). */
export interface MobileIntegrationDisconnectResponse {
  status: 'revoked';
  provider: ConnectorProviderSlug;
}

// ── privacy & data (rights export/delete + shared links) ──────────────────────
//
// The native "Privacy & data" account-management surface, matching web /settings.
// Every route delegates to the SAME web lib the browser uses (assembleFamilyExport
// / scheduleFamilyDeletion / listSharedLinks / revokeShareLink), so the teen
// redaction, the reversible-by-grace deletion, and the audit writes are single-
// sourced (rules #1/#6).

/** GET /api/mobile/rights/export — the full teen-redacted export document the app
 * shares via the RN Share sheet. The shape is the lib's FamilyExportDocument. */
export type MobileExportResponse = FamilyExportDocument;

/** POST /api/mobile/rights/delete body — confirm-gated (literal true), never a bare
 * POST, so a deletion is only ever scheduled on an explicit intent. */
export interface MobileDeleteRequest {
  confirm: true;
}

/** The scheduled-deletion result: the reversible grace-period instant (ISO). The
 * worker erases only after this passes; clearing the stamp cancels it. */
export interface MobileDeleteResponse {
  status: 'scheduled';
  scheduledDeletionAt: string;
}

/** GET /api/mobile/village/shares — the family's currently-live shared links. */
export interface MobileSharedLinksResponse {
  links: SharedLink[];
}

/** POST /api/mobile/village/shares/revoke body — addresses ONE link by (kind, id). */
export interface MobileRevokeShareRequest {
  kind: ShareLinkKind;
  id: string;
}

/** The revoke result — the token is nulled + audited server-side (rules #1/#6). */
export interface MobileRevokeShareResponse {
  status: 'revoked';
}
