import { useState } from 'react';
import { Pressable, View } from 'react-native';

import { DraftedActionCard } from '@/components/hale/drafted-action-card';
import { AppText } from '@/components/ui/app-text';
import { API_BASE, ApiError, signalUnauthorized } from '@/lib/api-client';
import { buildActionRequest, parseDraftResponse } from '@/lib/approval-gate';
import type { ActionIntent } from '@/lib/coach-api';
import { TOKEN_KEY, tokenStorage } from '@/lib/token-storage';

/**
 * A gated action chip — the inline-action thesis on mobile. Tapping it routes the
 * intent through the EXISTING approval engine (POST /api/coach/action), which
 * creates a DRAFT a parent must approve (rule #4: Hale never auto-acts). On a
 * successful draft the chip hands off to an inline DraftedActionCard so the parent
 * approves or denies right here in the chat. Mirror of the web ActionChip.
 *
 * Rule #1: the chip renders ONLY the already-safe intent `label` — never the
 * drafted payload or raw content. The copy is honest: "drafting…" while in flight,
 * a retryable error on failure (never silent — CLAUDE.md #8), and only a 401
 * returns silently (the client bounces to sign-in, mirroring askHale).
 */

type State = 'idle' | 'drafting' | 'error';

/** POST the draft with the Bearer token; returns the drafted actionId or null. A
 * 401 throws (bounces to sign-in); a network failure throws an ApiError(0). Reads
 * the exact status via parseDraftResponse (202 + string id), mirroring coach-api. */
async function draftAction(intent: ActionIntent, sourceAnswer: string): Promise<string | null> {
  if (!API_BASE) throw new ApiError(0, 'API base URL is not configured.');
  const token = await tokenStorage.get(TOKEN_KEY);
  const headers: Record<string, string> = {
    accept: 'application/json',
    'content-type': 'application/json',
  };
  if (token) headers.authorization = `Bearer ${token}`;

  let res: Response;
  try {
    res = await fetch(`${API_BASE}/api/coach/action`, {
      method: 'POST',
      headers,
      // The mobile chat is whole-family scoped — no focused child to pass.
      body: JSON.stringify(buildActionRequest(intent.kind, null, sourceAnswer)),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new ApiError(0, 'Network error — check your connection and try again.');
  }
  if (res.status === 401) {
    await signalUnauthorized();
    throw new ApiError(401, 'Your session has expired. Please sign in again.');
  }
  const body = (await res.json().catch(() => ({}))) as { actionId?: unknown };
  return parseDraftResponse({ status: res.status, actionId: body.actionId });
}

export function ActionChip({
  intent,
  sourceAnswer,
}: {
  intent: ActionIntent;
  sourceAnswer: string;
}) {
  const [state, setState] = useState<State>('idle');
  const [actionId, setActionId] = useState<string | null>(null);

  const draft = async () => {
    if (state === 'drafting') return;
    setState('drafting');
    try {
      const id = await draftAction(intent, sourceAnswer);
      if (id) {
        setActionId(id);
      } else {
        setState('error');
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return;
      setState('error');
    }
  };

  if (actionId)
    return <DraftedActionCard actionId={actionId} intent={intent} sourceAnswer={sourceAnswer} />;

  const label =
    state === 'drafting'
      ? 'Drafting…'
      : state === 'error'
        ? "Couldn't draft — try again"
        : intent.label;

  return (
    <View className="mb-3 self-start">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={intent.label}
        accessibilityState={{ disabled: state === 'drafting' }}
        onPress={draft}
        disabled={state === 'drafting'}
        className="h-11 flex-row items-center justify-center rounded-full border border-accent bg-accent-tint px-4 active:opacity-80"
      >
        <AppText variant="meta" className="text-accent">
          {label}
        </AppText>
      </Pressable>
    </View>
  );
}
