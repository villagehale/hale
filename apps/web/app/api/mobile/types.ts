import type { ChildCompanionView } from '~/lib/companion/queries';
import type { RecentLogView } from '~/lib/companion/recent-logs';
import type { ApprovalView } from '~/lib/dashboard/approvals';
import type { FamilyBasicsView } from '~/lib/dashboard/family-basics';
import type { FamilyMembersView } from '~/lib/dashboard/family-members';
import type { PlanChildItem } from '~/lib/plan/week';
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

export interface MobileLogResponse {
  status: 'logged';
}
