import type { PushDecision } from './push-permission';
import { tokenStorage } from './token-storage';

/** Where the parent's remembered push choice lives — same secure store as the session
 * token (Keychain/Keystore native, localStorage on the web preview). Distinct key. */
const DECISION_KEY = 'hale.push.decision';

/**
 * Persists the parent's own push decision so the moment-of-value prompt doesn't nag
 * every launch. Only a decline is stored (with when), which is what the re-ask window
 * reads; a grant lives in the OS permission itself, so there's nothing to persist there.
 */
export const pushDecisionStorage = {
  async get(): Promise<PushDecision> {
    const raw = await tokenStorage.get(DECISION_KEY);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as { kind?: unknown; at?: unknown };
      if (parsed.kind === 'declined' && typeof parsed.at === 'string') {
        return { kind: 'declined', at: parsed.at };
      }
    } catch {
      // A corrupt value is treated as "no decision" — the prompt can offer again.
    }
    return null;
  },
  recordDecline(at: string = new Date().toISOString()): Promise<void> {
    return tokenStorage.set(DECISION_KEY, JSON.stringify({ kind: 'declined', at }));
  },
  clear(): Promise<void> {
    return tokenStorage.remove(DECISION_KEY);
  },
};
