import { type FamilyStage, deriveStage } from '@hale/types';

/**
 * Dynamic, stage-aware Ask Hale prompts — the replacement for the old static
 * example chips. Each child's suggestions are derived from their `deriveStage`, so
 * the family's ONE conversation offers the right starting points for whoever the
 * parent is focused on: a toddler's parent sees "tantrums at 2?", a teen's parent
 * sees teen-appropriate prompts. Pure, no I/O.
 *
 * Rule #1 (content redaction): a teenager's PROMPTS are generic to the stage and
 * NEVER name the child or carry age detail — the same redaction the agent context
 * applies. The scope-chip LABEL is separate and shows the child's name (policy 1),
 * so two teens are distinct. The whole-family group (childId null) is always
 * present as the default scope.
 */

export interface SuggestionChild {
  id: string;
  dateOfBirth: string;
  /** The child's given name — shown on the scope chip (policy 1) and used to personalize non-teen copy. */
  name: string | null;
}

export interface SuggestionGroup {
  /** The child this group scopes to, or null for the whole family (default). */
  childId: string | null;
  /** Display name for the scope chip: the child's name (incl. a teen, policy 1);
   * null for the family group and when the child has no name on file. */
  label: string | null;
  /** The child's stage, or null for the family group. */
  stage: FamilyStage | null;
  prompts: string[];
}

const FAMILY_PROMPTS: readonly string[] = [
  'what should we be doing this week?',
  "what's good near us this weekend?",
  'help me plan the week',
];

const STAGE_PROMPTS: Record<FamilyStage, readonly string[]> = {
  newborn: [
    'is this much crying normal?',
    'when do we start solids?',
    'how much sleep is typical right now?',
  ],
  toddler: [
    'tantrums at 2 — what helps?',
    'are we ready for potty training?',
    'how many words should they have?',
  ],
  child: [
    'how much screen time is okay?',
    'help with homework battles',
    'is this normal for friendships at this age?',
  ],
  teenager: [
    'how do I give more independence?',
    'screens and privacy — where do I draw the line?',
    "checking in on mood and wellbeing",
  ],
};

/**
 * Build a suggestion group per child plus a whole-family default. Every group's
 * label is the child's name (policy 1 — a teen included, so two teens are
 * distinct); a teenager's PROMPTS stay stage-generic and never name the child
 * (rule #1 content redaction).
 */
export function suggestionsForChildren(
  children: readonly SuggestionChild[],
  now: Date = new Date(),
): SuggestionGroup[] {
  const family: SuggestionGroup = {
    childId: null,
    label: null,
    stage: null,
    prompts: [...FAMILY_PROMPTS],
  };

  const perChild = children.map((child): SuggestionGroup => {
    const stage = deriveStage(child.dateOfBirth, now);
    // Policy 1: the scope chip shows the child's NAME — including a teenager (the
    // parent entered it, and two teens must never both read "your teen"),
    // consistent with scopeChildren/thread.ts. This is the LABEL only; a teen's
    // CONTENT stays redacted — the prompts below stay stage-generic and never name
    // the child.
    return {
      childId: child.id,
      label: child.name,
      stage,
      prompts: [...STAGE_PROMPTS[stage]],
    };
  });

  return [family, ...perChild];
}
