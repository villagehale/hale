import { currentFamilyId } from '~/lib/family';
import { db } from '~/lib/db';
import { type TranscriptMessage, loadLatestThread } from './conversation';

/**
 * The chat UI's initial state. `conversationId` is null when there is nothing to
 * continue (no family yet, or a family with no thread); the first question then
 * opens a fresh conversation. `messages` seed the rendered thread on load.
 */
export interface ThreadSeed {
  conversationId: string | null;
  messages: TranscriptMessage[];
}

const EMPTY_SEED: ThreadSeed = { conversationId: null, messages: [] };

/**
 * Server-side rehydration for Ask Hale. Resolves the current request's family
 * (rule #1 — never another family's thread; fails closed to null when no family),
 * then loads its most recent conversation so a page can seed the chat UI with
 * persisted history. Returns an empty seed (never null) so callers render the
 * same shape whether or not history exists — no special-casing in the component.
 */
export async function loadLatestThreadForRequest(): Promise<ThreadSeed> {
  const familyId = await currentFamilyId();
  if (!familyId) {
    return EMPTY_SEED;
  }

  const thread = await loadLatestThread(familyId, db());
  return thread ?? EMPTY_SEED;
}
