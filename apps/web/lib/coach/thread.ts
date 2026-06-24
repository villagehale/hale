import { deriveStage } from '@hale/types';
import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { currentFamilyId } from '~/lib/family';
import { db } from '~/lib/db';
import { type TimelineMessage, loadLatestThread } from './conversation';
import { type SuggestionGroup, suggestionsForChildren } from './suggestions';

export type { SuggestionGroup } from './suggestions';

/**
 * The continuous-companion shell's initial state. There is ONE ongoing
 * conversation per family — not threads — so `conversationId` is the family's
 * single thread (null only when none exists yet, opened on the first turn). The
 * timeline is that one relationship's full, scrollable, filterable history. The
 * child chips and stage-aware suggestions let the parent scope the conversation
 * and start from the right prompt for whoever they're focused on.
 */

/** A child the parent can focus the conversation on (the per-child chip). Teen
 * detail withheld at the source (rule #1): a teenager's label is null. */
export interface TimelineChild {
  id: string;
  /** Withheld for a teenager (rule #1). */
  label: string | null;
  teenRedacted: boolean;
}

export interface ThreadSeed {
  conversationId: string | null;
  /** The one conversation's full timeline, scope-tagged for filtering. */
  timeline: TimelineMessage[];
  /** Children the parent can focus on (default scope is the whole family). */
  children: TimelineChild[];
  /** Stage-aware starting prompts, per child + a whole-family default. */
  suggestions: SuggestionGroup[];
}

const EMPTY_SEED: ThreadSeed = {
  conversationId: null,
  timeline: [],
  children: [],
  suggestions: suggestionsForChildren([]),
};

/**
 * Server-side rehydration for the Ask Hale shell. Resolves the current request's
 * family (rule #1 — never another family's thread; fails closed to the empty seed
 * when no family), then loads its one continuous conversation plus the family's
 * children and stage-aware suggestions. Returns the empty seed (never null) so
 * callers render the same shape whether or not history exists.
 */
export async function loadThreadShellForRequest(): Promise<ThreadSeed> {
  // Credential-less preview (no DATABASE_URL): the same calm empty seed the
  // companion loader returns at this boundary — no DB to resolve a family from.
  if (!process.env.DATABASE_URL) {
    return EMPTY_SEED;
  }
  const familyId = await currentFamilyId();
  if (!familyId) {
    return EMPTY_SEED;
  }

  const database = db();
  const childRows = await database
    .select({
      id: schema.children.id,
      name: schema.children.name,
      dateOfBirth: schema.children.dateOfBirth,
    })
    .from(schema.children)
    .where(eq(schema.children.familyId, familyId));

  const children: TimelineChild[] = childRows.map((c) => {
    const teen = deriveStage(c.dateOfBirth) === 'teenager';
    return { id: c.id, label: teen ? null : c.name, teenRedacted: teen };
  });

  const suggestions = suggestionsForChildren(
    childRows.map((c) => ({ id: c.id, dateOfBirth: c.dateOfBirth, name: c.name })),
  );

  const thread = await loadLatestThread(familyId, database);

  return {
    conversationId: thread?.conversationId ?? null,
    timeline: thread?.timeline ?? [],
    children,
    suggestions,
  };
}
