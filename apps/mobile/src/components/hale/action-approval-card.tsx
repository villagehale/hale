import { useState } from 'react';
import { View } from 'react-native';

import { AppText } from '@/components/ui/app-text';
import { Button } from '@/components/ui/button';
import { API_BASE, ApiError, signalUnauthorized } from '@/lib/api-client';
import { approveResult, declineResult } from '@/lib/approval-gate';
import { TOKEN_KEY, tokenStorage } from '@/lib/token-storage';

/**
 * The inline approval gate on mobile — the mirror of the web ActionApprovalCard +
 * Approve/Dismiss buttons, folded into one card (the QuickLogCard shape). Once a
 * chip drafts an action, this lets the parent approve or reject it WITHOUT leaving
 * the chat.
 *
 * Rule #1: it renders ONLY the already-safe intent `label` — it never fetches or
 * renders the drafted action's payload, so no raw child/teen content reaches this
 * surface. Rules #3/#4/#6: Approve → POST /api/actions/:id/approve and Reject →
 * /decline go through the SAME shipping audited, reviewer-gated routes as the
 * Approvals surface; this card adds no client path that mutates action state
 * directly. Honest copy: on approve it settles to "Approved" (queued for the drain),
 * NEVER "Done"/"Logged"/"Scheduled". Errors are surfaced and retryable, never
 * silent (CLAUDE.md #8); only a 401 returns silently (the client bounces to
 * sign-in, mirroring runConcierge).
 */

type Status = 'idle' | 'approving' | 'declining' | 'approved' | 'dismissed' | 'error';

/** POST to an action route with the Bearer token; returns the HTTP status. A 401
 * throws (bounces to sign-in); a network failure throws an ApiError(0). The
 * status-inspecting fetch mirrors coach-api.ts, which also bypasses api() to read
 * the exact code the approval contract turns on. */
async function postAction(path: string): Promise<number> {
  if (!API_BASE) throw new ApiError(0, 'API base URL is not configured.');
  const token = await tokenStorage.get(TOKEN_KEY);
  const headers: Record<string, string> = { accept: 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new ApiError(0, 'Network error — check your connection and try again.');
  }
  if (res.status === 401) {
    await signalUnauthorized();
    throw new ApiError(401, 'Your session has expired. Please sign in again.');
  }
  return res.status;
}

export function ActionApprovalCard({ actionId, label }: { actionId: string; label: string }) {
  const [status, setStatus] = useState<Status>('idle');
  const busy = status === 'approving' || status === 'declining';

  const approve = async () => {
    if (busy) return;
    setStatus('approving');
    try {
      setStatus(approveResult(await postAction(`/api/actions/${actionId}/approve`)));
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return;
      setStatus('error');
    }
  };

  const reject = async () => {
    if (busy) return;
    setStatus('declining');
    try {
      setStatus(declineResult(await postAction(`/api/actions/${actionId}/decline`)));
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return;
      setStatus('error');
    }
  };

  if (status === 'dismissed') return null;

  if (status === 'approved') {
    return (
      <View className="mb-3 max-w-[92%] self-start rounded-lg border border-rule bg-sage-tint px-4 py-3">
        <AppText variant="meta" className="text-sage">
          Approved — {label}
        </AppText>
      </View>
    );
  }

  const errored = status === 'error';

  return (
    <View className="mb-3 max-w-[92%] self-start rounded-lg border border-rule bg-accent-tint px-4 py-3">
      <AppText variant="body" className="text-ink">
        {label}
      </AppText>

      {errored ? (
        <AppText variant="meta" className="mt-2 text-berry" accessibilityLiveRegion="polite">
          Something went wrong. Try again.
        </AppText>
      ) : null}

      <View className="mt-3 flex-row gap-2">
        <Button
          label={status === 'approving' ? 'Approving…' : errored ? 'Try again' : 'Approve'}
          onPress={approve}
          className="h-11 flex-1"
        />
        <Button
          label={status === 'declining' ? 'Rejecting…' : 'Reject'}
          variant="secondary"
          onPress={reject}
          className="h-11"
        />
      </View>
    </View>
  );
}
