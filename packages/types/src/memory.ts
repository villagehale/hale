/**
 * Memory slices — the scoped views agents receive from Memory Writer.
 * Each agent gets ONLY what it needs. This is the privacy isolation.
 */

export type MemoryFactType =
  | 'preference'
  | 'routine'
  | 'medical'
  | 'logistic'
  | 'relationship'
  | 'voice';

export interface FamilyMemoryFactView {
  id: string;
  childId?: string;
  factType: MemoryFactType;
  factKey: string;
  factValue: unknown;
  confidence: number;
  validFrom: string;
}

export interface FamilyMemoryEpisodeView {
  id: string;
  childId?: string;
  occurredAt: string;
  episodeType: string;
  summary: string;
  sentimentScore?: number;
}

/** Slice handed to Drafter. */
export interface DrafterMemorySlice {
  relevantFacts: FamilyMemoryFactView[];
  relevantEpisodes: FamilyMemoryEpisodeView[];
}

/** Slice handed to Coach — NO email contents, NO calendar details. */
export interface CoachMemorySlice {
  relevantFacts: FamilyMemoryFactView[];
  relevantEpisodes: FamilyMemoryEpisodeView[];
}

/** Lean slice handed to Classifier — just enough to disambiguate. */
export interface ClassifierContextSlice {
  childrenAgesMonths: number[];
  province: string;
  timezone: string;
  knownClinics: string[];
  knownDaycares: string[];
}

export type ContextScope =
  | { agent: 'classifier' }
  | { agent: 'drafter'; eventType: string }
  | { agent: 'coach'; childId?: string }
  | { agent: 'reviewer'; actionType: string };
