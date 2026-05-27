/**
 * Parenting style — Coach uses this to match advice to family preferences.
 */
export type ParentingStyle =
  | 'attachment'
  | 'gentle'
  | 'authoritative'
  | 'free_range'
  | 'structured'
  | 'undecided';

export type CoachingFramework =
  | 'karp' // The Happiest Baby on the Block
  | 'ferber' // Ferber method
  | 'markham' // Aha! Parenting
  | 'siegel' // The Whole-Brain Child
  | 'lansbury' // Janet Lansbury / RIE
  | 'health_canada'
  | 'aap' // American Academy of Pediatrics
  | 'cps'; // Canadian Paediatric Society

export interface FrameworkCitation {
  framework: CoachingFramework;
  /** Specific reference within the framework (book chapter, page, web link). */
  reference: string;
  /** Pull-quote or summary attributed to the framework. */
  excerpt?: string;
}

export interface ChildProfile {
  id: string;
  name: string;
  ageInMonths: number;
  dateOfBirth: string;
  parentingStyle: ParentingStyle;
  notes?: string;
}
