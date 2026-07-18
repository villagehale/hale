/**
 * Response shapes for the mobile API, MIRRORED from
 * apps/web/app/api/mobile/types.ts (and the page-loader view types it re-exports).
 * The web app owns the source of truth; these are hand-copied because the native
 * bundle can't import server route code. Keep in sync when the server types change.
 */

// ── companion (from @hale/types CompanionView + apps/web ChildCompanionView) ──

export type FamilyStage = 'newborn' | 'toddler' | 'child' | 'teenager';

export interface HealthItem {
  ageMonths: number;
  kind: 'immunization' | 'well_child_visit';
  what: string;
  note: string;
}

export interface UpcomingHealthItem extends HealthItem {
  /** Stable id `${ageMonths}-${kind}` — keys the list and matches "mark done". */
  key: string;
  dueInWeeks: number;
  /** True when this item has been marked done for this child (mirrors web). */
  done: boolean;
}

export interface Milestone {
  area: 'motor' | 'language' | 'social' | 'cognitive' | 'independence';
  what: string;
  typicalWindowMonths: readonly [number, number];
  note: string;
}

export interface MilestoneStatus extends Milestone {
  timing: 'upcoming' | 'in_window' | 'watch';
  /** True when a matching milestone has been logged/marked done (mirrors web). */
  done: boolean;
}

export interface CompanionView {
  stage: FamilyStage;
  ageMonths: number;
  name: string | null;
  nextHealth: readonly UpcomingHealthItem[];
  /** The single upcoming health item worth leading a "today" surface with, or null
   * (soonest not-done within the horizon). Mirrors @hale/types CompanionView. */
  todayHealth: UpcomingHealthItem | null;
  /** Health items whose scheduled age recently passed and are NOT marked done —
   * "was due at X — done?". Bounded back a few months. Mirrors @hale/types. */
  recentlyPassedHealth: readonly UpcomingHealthItem[];
  milestones: readonly MilestoneStatus[];
  whatsNow: readonly string[];
  whatsNext: string;
}

export interface ChildCompanionView extends CompanionView {
  id: string;
}

export interface RecentLogView {
  id: string;
  childId: string | null;
  episodeType: string;
  summary: string;
  occurredAt: string;
}

/** A logged episode for the paginated glance-detail sheet (mirrors web LogView).
 * The structured NUMERICS are lifted from payload by the shared read — numbers
 * only, never the raw payload / note (rule #1). Present only when the episode
 * carries them. */
export interface LogView {
  id: string;
  childId: string | null;
  episodeType: string;
  summary: string;
  /** ISO string. */
  occurredAt: string;
  durationMin?: number;
  amountMl?: number;
  feedKind?: string;
  /** Growth measure kind (weight/height/head), lifted from payload; present only
   * alongside value + unit (mirrors web LogView, lifted as a set). */
  measureKind?: string;
  value?: number;
  unit?: string;
}

/** One keyset page of logs, newest first, with the cursor for the next page
 * (mirrors web LogsPage / MobileLogsResponse). */
export interface MobileLogsResponse {
  logs: LogView[];
  /** occurredAt to page before on the next request, or null on the last page. */
  nextCursor: string | null;
}

// ── docs vault (from apps/web lib/docs/documents DocumentView + route envelopes) ──

/** A document row flattened for the vault list. Never carries the storage path or a
 * URL — a URL is minted per-view through the [id]/url route. Mirrors web DocumentView. */
export interface DocumentView {
  id: string;
  childId: string | null;
  kind: string;
  title: string;
  mime: string;
  sizeBytes: number;
  createdAt: string;
}

/** The family's live documents, most-recent first (teen-redacted). */
export interface MobileDocsResponse {
  documents: DocumentView[];
}

/** The upload result — the freshly-minted doc id only (no URL). */
export interface MobileDocUploadResponse {
  status: 'uploaded';
  id: string;
}

/** A short-TTL signed URL for viewing one document (minted per view, never stored). */
export interface MobileDocUrlResponse {
  url: string;
}

/** The soft-delete result (the row stays for the audit trail). */
export interface MobileDocDeleteResponse {
  status: 'deleted';
}

// ── village (from apps/web lib/village/mappers + queries) ─────────────────────

export interface VillageCandidateView {
  id: string;
  /** Opaque child id this pick was discovered for, or null for a family-wide pick
   * (mirrors web; an id, never a name — rule #1). */
  childId: string | null;
  title: string;
  kind: string;
  /** How the activity recurs — "seasonal" | "one-time" | "ongoing" — or null when
   * unclassified / teen-redacted. Drives the cadence filter + card chip. */
  cadence: string | null;
  /** Seasons a seasonal activity runs (the server already applied the in-season
   * gate); null on non-seasonal / teen-redacted rows. */
  seasons: string[] | null;
  /** ISO instant the discovery run happened — rendered as a "found N ago" stamp. */
  discoveredAt: string;
  summary: string;
  coverageNote: string | null;
  sourceUrl: string | null;
  acceptHref: string;
  endorseHref: string;
  /** The private-save ("I'm interested") toggle POSTs here. */
  saveHref: string;
  shareHref: string;
  endorsementCount: number;
  endorsedByFamily: boolean;
  /** Whether THIS family has privately saved this candidate — drives the bookmark's
   * filled state. Only ever this family's own save (rule #1). */
  saved: boolean;
  accepted: boolean;
  lat: number | null;
  lng: number | null;
  venueName: string | null;
  /** The venue's PUBLIC Google rating (0.0–5.0) + count, set ONLY when Places had
   * a real value (never fabricated). Null → no rating shown. Null on teen rows. */
  rating: number | null;
  ratingCount: number | null;
  /** Honest, presence-gated attribute chips (price band / age hint / indoor-outdoor);
   * null → no chip. Null on teen-redacted rows (rule #1). */
  priceLevel: string | null;
  ageRange: string | null;
  indoorOutdoor: string | null;
  teenAttributed: boolean;
}

export interface RoutineItemView {
  title: string;
  kind: string;
  stageNote: string;
  /** Weekday the agent placed this item on ("monday"–"sunday"), or null (mirrors web). */
  day: string | null;
  teenAttributed: boolean;
}

export interface RoutineProposalView {
  id: string;
  weekOf: string;
  items: RoutineItemView[];
}

export interface VillageData {
  candidates: VillageCandidateView[];
  routine: RoutineProposalView | null;
}

/** A hand-verified public local resource for the Village "Resources" rail (mirrors
 * web CuratedResourceView). Family-agnostic reference data — no PII (rule #1). */
export interface CuratedResourceView {
  id: string;
  name: string;
  category: string;
  area: string;
  url: string;
  description: string;
}

// ── plan (from apps/web lib/plan/week) ────────────────────────────────────────

export interface PlanChildItem {
  key: string;
  childName: string | null;
  kindLabel: string;
  what: string;
  when: string;
  /** True on the single locked line standing in for a 13+ teen's items (rule #1). */
  teenRedacted?: boolean;
}

/** One scope option for the AddPlan "who is this for" picker (mirrors web
 * ScopeChild). `label` is the child's given name (teen-safe on a scope chip — it
 * disambiguates WHICH child, policy 1), or null when the child has no name on file. */
export interface ScopeChild {
  id: string;
  label: string | null;
}

/** One parent-authored plan, joined to the child it's scoped to (mirrors web
 * AuthoredPlanView). A parent's OWN plan about their 13+ teen is the parent's own
 * content (teen-exempt), so title/notes render in full and the tag shows the name. */
export interface AuthoredPlanView {
  id: string;
  title: string;
  notes: string | null;
  /** ISO datetime, or null for an undated ("sometime this week") plan. */
  scheduledFor: string | null;
  /** When the parent marked this plan done, or null while open — drives the
   * settled/dimmed treatment and the current-week scoping. */
  completedAt: string | null;
  /** null = whole family; otherwise the scoped child. */
  childId: string | null;
  /** The scoped child's given name, or null for a whole-family plan. */
  childName: string | null;
}

// ── family + approvals (from apps/web lib/dashboard) ──────────────────────────

export interface MemberView {
  name: string | null;
  email: string;
  role: string;
}

export interface FamilyMembersView {
  primary: MemberView | null;
  coParent: MemberView | null;
}

export interface FamilyLocationView {
  country: string | null;
  province: string | null;
  city: string | null;
  postalCode: string | null;
}

export type ChildGender = 'boy' | 'girl' | 'nonbinary' | 'unspecified';

export interface FamilyChildBasics {
  id: string;
  name: string;
  /** Optional family / last name, or null when not given (rule #1). */
  lastName: string | null;
  dateOfBirth: string;
  /** Stored gender enum, so an edit form prefills it. */
  gender: ChildGender;
  /** Free-text interest tags driving discovery, so an edit form prefills them. */
  interests: string[];
  stageLabel: string;
}

export interface FamilyBasicsView {
  location: FamilyLocationView;
  planTier: 'free' | 'plus' | 'family';
  intents: string[];
  children: FamilyChildBasics[];
}

export interface ApprovalView {
  id: string;
  actionType: string;
  summary: string;
  preview: string;
  payload: Record<string, unknown> | null;
  /** Opaque child id the action is for, or null for a family-wide action (mirrors web). */
  childId: string | null;
  /** Child's display name for the "for Mia" tag, or null when family-wide (mirrors web). */
  childLabel: string | null;
  verdict: string;
  draftedAt: string;
  /** True when the draft's content is redacted for a 13+ teen (rule #1). */
  teenRedacted: boolean;
}

// ── the endpoint response envelopes (from apps/web/app/api/mobile/types.ts) ───

/** The Home stat-row counts — counts only, teen-redacted at the source (rule #1). */
export interface HomeStats {
  logsThisWeek: number;
  upcomingHealth: number;
  savedPlaces: number;
}

export interface MobileHomeResponse {
  children: ChildCompanionView[];
  village: VillageData;
  members: FamilyMembersView;
  stats: HomeStats;
  viewer: { name: string | null };
}

export interface MobileCompanionResponse {
  children: ChildCompanionView[];
  recentLogs: RecentLogView[];
}

/** The Village tab response: VillageData plus the optional Resources rail. Present
 * only on the standing feed (a directory is not season-scoped); an older client
 * that ignores `resources` still reads candidates/routine. */
export interface MobileVillageResponse extends VillageData {
  resources?: CuratedResourceView[];
}

/** The More → Saved screen: the family's privately-saved candidates (all saved:true). */
export interface MobileSavedResponse {
  candidates: VillageCandidateView[];
}

/** GET /api/mobile/village/:id — one candidate for the pushed Activity route,
 * teen-redacted at the mapper (rule #1). `candidate` is null when the id is unknown
 * or belongs to another family (never reveals a redacted card exists), so the route
 * lands on its honest empty state. */
export interface MobileVillageCandidateResponse {
  candidate: VillageCandidateView | null;
}

export interface MobilePlanResponse {
  /** Parent-authored plans, chronological (soonest scheduledFor first), the same
   * session-scoped, teen-exempt view web /plan leads with. Folded into a Mon–Sun
   * spine client-side using `timeZone`. */
  authoredPlans: AuthoredPlanView[];
  /** The family's IANA zone, so the client builds the SAME current-week spine the
   * web page does. */
  timeZone: string;
  /** The parent's chosen first day of the week (0=Sun, 1=Mon), so the client orders
   * the same spine columns the web page does. Delivered alongside plan data. */
  weekStartDay: number;
  /** The family's children as scope options for the AddPlan picker (whole-family +
   * each child), teen-safe (a scope chip disambiguates WHICH child, policy 1). */
  scopeChildren: ScopeChild[];
  addedActivities: VillageCandidateView[];
  routine: RoutineProposalView | null;
  childItems: PlanChildItem[];
  hasPlan: boolean;
}

// ── plan write (POST /api/mobile/plan) ────────────────────────────────────────

export interface CreatePlanRequest {
  action: 'create';
  title: string;
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
  /** The signed-in parent (from THIS session) for the More profile header —
   * members.primary reads wrong for a co-parent. */
  viewer: { name: string | null; email: string | null };
}

export interface MobileApprovalsResponse {
  approvals: ApprovalView[];
}

export type HistoryStatus = 'executed' | 'declined' | 'reverted' | 'held' | 'failed';

/** A past, resolved action for the Approvals → History segment. Extends the live
 * card's teen-safe fields with its resolved status + when (mirrors web HistoryView). */
export interface HistoryView extends ApprovalView {
  status: HistoryStatus;
  resolvedAt: string;
}

export interface MobileApprovalsHistoryResponse {
  history: HistoryView[];
}

// ── messages (from apps/web lib/messages/mappers) ─────────────────────────────

export type MessageKind = 'digest' | 'action';

export type MessageActionState =
  | 'drafted_for_approval'
  | 'autonomous'
  | 'needs_human'
  | 'reverted';

export interface MessageView {
  id: string;
  kind: MessageKind;
  /** Short eyebrow — "Daily brief" for a digest, the action category for an action. */
  eyebrow: string;
  /** The note's one line: the digest brief prose, or the lifecycle framing. */
  body: string;
  /** The family-zone timestamp the row is stamped with. */
  when: string;
  /** For an action row: the lifecycle state, so a drafted row navigates to Approvals
   * (mirrors web; absent on a digest row). */
  actionState?: MessageActionState;
  /** True when the action's content is redacted for a 13+ teen (rule #1). */
  teenRedacted?: boolean;
  /** True when this note is stamped on the family's current local day — the Notifications
   * page buckets on it ("Today" vs "Earlier"). Computed server-side in the family zone. */
  today?: boolean;
}

export interface MobileMessagesResponse {
  messages: MessageView[];
}

// ── plan tiers (from apps/web lib/plan/catalog, derived from @hale/types) ──────

export type PlanTier = 'free' | 'plus' | 'family';

/** One tier's display card — names/prices/features come from the server (derived
 * from the @hale/types source of truth), never hardcoded here. */
export interface PlanTierView {
  tier: PlanTier;
  name: string;
  tagline: string;
  monthlyPrice: string;
  annualPrice: string;
  features: string[];
  isFree: boolean;
}

export interface PlanCatalogView {
  currentTier: PlanTier;
  tiers: PlanTierView[];
}

export interface MobilePlanTiersResponse {
  catalog: PlanCatalogView;
}

// ── family write (POST /api/mobile/family) ────────────────────────────────────

export interface EditChildRequest {
  action: 'editChild';
  childId: string;
  name: string;
  /** Date-only `YYYY-MM-DD`. */
  dateOfBirth: string;
  lastName?: string;
  gender?: string;
  /** Comma-separated free-text interests, e.g. "swimming, music". */
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

// ── invite (POST /api/mobile/invite) ──────────────────────────────────────────
//
// Mints a co-parent invite via the SAME server lib the web /api/invite route uses
// (createFamilyInvite → rule #5 consent + rule #6 audit). The app shares the returned
// redeem link; acceptance happens web-side. No token material travels beyond the
// single-use redeem URL.

/** The absolute redeem link for a freshly-minted co-parent invite (expires in 14
 * days, single-use). */
export interface MobileInviteResponse {
  link: string;
}

// ── settings (GET + POST /api/mobile/settings) ────────────────────────────────

export type NotificationPref = 'dailyBriefEmail';

export interface NotificationPrefsView {
  dailyBriefEmail: boolean;
}

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

/** Mirror of @hale/types UnitSystem — the display choice for growth measurements
 * (storage is always metric). The native bundle mirrors the union locally. */
export type UnitSystem = 'metric' | 'imperial';

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

export type PushPref = 'pushNewPicks' | 'pushHealthReminders';

export interface PushPrefsView {
  pushNewPicks: boolean;
  pushHealthReminders: boolean;
}

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

// ── connectors (GET /api/mobile/integrations, POST .../[provider]/disconnect,
//    GET /api/mobile/integrations/connect-url) ──────────────────────────────────
//
// Connection PLUMBING only: the app learns whether each read-only Google connector
// is linked, opens a consent URL to link one, and revokes one. No token material,
// no scopes, and nothing about mailbox/calendar CONTENT ever travels here (rule #1).

export type ConnectorProvider = 'gcal' | 'gmail' | 'gdrive';

/** The honest, UI-facing connection status the route normalizes the raw
 * integration_status into — 'connected' only when the connection is truly active;
 * 'error' means "needs reconnecting"; 'not_connected' otherwise. */
export type IntegrationStatus = 'connected' | 'not_connected' | 'error';

/** One connector's state for the family. Never carries tokens or scopes (rule #1). */
export interface ConnectorState {
  provider: ConnectorProvider;
  status: IntegrationStatus;
  /** ISO instant the connection was made — an activity signal only, never content.
   * Omitted (never null) when the connector was never linked; mirrors the web wire
   * type, which the server always emits as a string or omits the key. */
  connectedAt?: string;
}

export interface MobileIntegrationsResponse {
  connectors: ConnectorState[];
}

/** The disconnect result (the connection is revoked + audited server-side, rule #6). */
export interface MobileIntegrationDisconnectResponse {
  status: 'revoked';
  provider: ConnectorProvider;
}

/** The Google consent URL to open in a browser for a connector connect flow. */
export interface MobileConnectUrlResponse {
  url: string;
}

// ── privacy & data (rights export/delete + shared links) ──────────────────────
//
// The "Privacy & data" account-management surface, matching web /settings. Every
// route delegates to the SAME web lib the browser uses, so the teen redaction, the
// reversible-by-grace deletion, and the audit writes are single-sourced (rules
// #1/#6). MIRRORED from apps/web/app/api/mobile/types.ts + lib/rights/export.ts.

/** One teen-redacted trail row in the export (mirrors the web TrailView on the
 * wire; the enum-typed tone/actor serialize as strings). The app never renders
 * these — it shares the whole document as JSON — so the mirror stays structural. */
export interface ExportTrailEntry {
  id: string;
  time: string;
  date: string;
  dayKey: string;
  tone: string;
  actor: string;
  summary: string;
  noun: string;
  link: string | null;
  childLabel: string | null;
}

/** GET /api/mobile/rights/export — the full teen-redacted export document (PIPEDA/
 * Law 25 right-to-access). Shared as JSON via the RN Share sheet. */
export interface FamilyExportDocument {
  exportedAt: string;
  family: {
    id: string;
    displayName: string;
    location: FamilyLocationView;
    planTier: FamilyBasicsView['planTier'];
    intents: string[];
  };
  children: FamilyChildBasics[];
  members: FamilyMembersView;
  savedActivities: { title: string; savedAt: string }[];
  trail: ExportTrailEntry[];
}

export type MobileExportResponse = FamilyExportDocument;

/** POST /api/mobile/rights/delete body — confirm-gated (literal true). */
export interface MobileDeleteRequest {
  confirm: true;
}

/** The scheduled-deletion result: the reversible grace-period instant (ISO). */
export interface MobileDeleteResponse {
  status: 'scheduled';
  scheduledDeletionAt: string;
}

export type ShareLinkKind = 'week_plan' | 'activity';

/** One currently-live shared link the family owns (a week plan or a local pick). */
export interface SharedLink {
  kind: ShareLinkKind;
  id: string;
  token: string;
  /** A human label — the week's date, or the activity's title. */
  title: string;
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
