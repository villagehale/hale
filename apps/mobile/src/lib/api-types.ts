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
  dueInWeeks: number;
}

export interface Milestone {
  area: 'motor' | 'language' | 'social' | 'cognitive' | 'independence';
  what: string;
  typicalWindowMonths: readonly [number, number];
  note: string;
}

export interface MilestoneStatus extends Milestone {
  timing: 'upcoming' | 'in_window' | 'watch';
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
  title: string;
  kind: string;
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
