import { API_BASE, ApiError, signalUnauthorized } from './api-client';
import { type ActivityEvent, foldCoachStream } from './coach-fold';
import { TOKEN_KEY, tokenStorage } from './token-storage';

/**
 * Ask Hale over POST /api/coach. The route streams newline-delimited JSON
 * (step/tool_call/tool_result/delta/reset/done/error), but React Native's fetch
 * has no readable response body, so we read the whole text and fold the events
 * post-hoc (see foldCoachStream): the assembled answer, the running
 * conversationId, and the settled tool steps that make up the activity trail
 * (rule #1: name/ok/preview only). The screen animates the assembled answer with
 * its existing typewriter, preserving the perceived-streaming feel, and shows the
 * trail as a folded disclosure above the answer.
 */

export type { ActivityEvent } from './coach-fold';

export interface CoachAnswer {
  answer: string;
  conversationId: string | null;
  /** The settled tool steps Hale ran, for the collapsible activity trail. */
  activity: ActivityEvent[];
}

export interface AskHaleRequest {
  question: string;
  conversationId?: string;
  intent?: string;
  focusedChildId?: string;
}

export async function askHale(req: AskHaleRequest): Promise<CoachAnswer> {
  if (!API_BASE) throw new ApiError(0, 'API base URL is not configured.');

  const token = await tokenStorage.get(TOKEN_KEY);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/x-ndjson',
  };
  if (token) headers.authorization = `Bearer ${token}`;

  let res: Response;
  try {
    res = await fetch(`${API_BASE}/api/coach`, {
      method: 'POST',
      headers,
      body: JSON.stringify(req),
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    throw new ApiError(0, 'Network error — check your connection and try again.');
  }

  if (res.status === 401) {
    await signalUnauthorized();
    throw new ApiError(401, 'Your session has expired. Please sign in again.');
  }
  if (res.status === 429) {
    throw new ApiError(429, 'Just a moment — try that again in a few seconds.');
  }
  if (!res.ok) throw new ApiError(res.status, `Ask Hale failed (${res.status}).`);

  const body = await res.text();
  const { answer, conversationId, activity, failed } = foldCoachStream(body);
  if (failed) throw new ApiError(500, 'Ask Hale ran into a problem. Please try again.');
  return { answer, conversationId, activity };
}
