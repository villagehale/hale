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
  shareHref: string;
  endorsementCount: number;
  endorsedByFamily: boolean;
  accepted: boolean;
  lat: number | null;
  lng: number | null;
  venueName: string | null;
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

export interface FamilyChildBasics {
  id: string;
  name: string;
  dateOfBirth: string;
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

export interface MobileHomeResponse {
  children: ChildCompanionView[];
  village: VillageData;
  members: FamilyMembersView;
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
}

export interface MobileMessagesResponse {
  messages: MessageView[];
}

// ── family write (POST /api/mobile/family) ────────────────────────────────────

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
