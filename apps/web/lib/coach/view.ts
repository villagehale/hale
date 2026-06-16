import type { CoachingFramework, FrameworkCitation } from '@hale/types';

/**
 * Display labels for each cited framework — the human-readable left side of the
 * "grounded in" lines the coach UI renders (e.g. `karp · The Happiest Baby`).
 * The reference (and optional excerpt) the model returns is appended.
 */
const FRAMEWORK_LABEL: Record<CoachingFramework, string> = {
  karp: 'karp · The Happiest Baby',
  ferber: 'ferber · Solve Your Child’s Sleep Problems',
  markham: 'markham · Aha! Parenting',
  siegel: 'siegel · The Whole-Brain Child',
  lansbury: 'lansbury · Janet Lansbury / RIE',
  health_canada: 'health canada · Caring for Kids',
  aap: 'AAP · American Academy of Pediatrics',
  cps: 'CPS · Canadian Paediatric Society',
};

/** The answer shape the /api/coach route returns and the coach UI renders. */
export interface CoachAnswerView {
  body: string;
  /** "grounded in" lines, the string[] shape the existing UI already renders. */
  citations: string[];
  followUps: string[];
  confidence: number;
  flagForPediatrician: boolean;
}

function citationLine(c: FrameworkCitation): string {
  const label = FRAMEWORK_LABEL[c.framework];
  const tail = c.excerpt ? `${c.reference} — ${c.excerpt}` : c.reference;
  return `${label} — ${tail}`;
}

export function toCoachAnswerView(answer: {
  adviceText: string;
  frameworkCitations: FrameworkCitation[];
  confidence: number;
  followUpQuestions: string[];
  flagForPediatrician: boolean;
}): CoachAnswerView {
  return {
    body: answer.adviceText,
    citations: answer.frameworkCitations.map(citationLine),
    followUps: answer.followUpQuestions,
    confidence: answer.confidence,
    flagForPediatrician: answer.flagForPediatrician,
  };
}
