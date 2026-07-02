import { API_BASE, ApiError } from './api-client';
import { TOKEN_KEY, tokenStorage } from './token-storage';

/**
 * Ask Hale over POST /api/coach. The route streams newline-delimited JSON
 * (delta/reset/done/error), but React Native's fetch has no readable response
 * body, so we read the whole text and fold the events into the final answer:
 * concatenated `delta` text, cleared by a `reset` (an intermediate tool turn),
 * ended by `done` (carrying the running conversationId) — the same fold the web
 * client applies incrementally. The screen animates the assembled answer with its
 * existing typewriter, preserving the perceived-streaming feel.
 */

type CoachEvent =
  | { type: 'delta'; text: string }
  | { type: 'reset' }
  | { type: 'done'; conversationId: string }
  | { type: 'error' };

export interface CoachAnswer {
  answer: string;
  conversationId: string | null;
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
    await tokenStorage.remove(TOKEN_KEY);
    throw new ApiError(401, 'Your session has expired. Please sign in again.');
  }
  if (res.status === 429) {
    throw new ApiError(429, 'Just a moment — try that again in a few seconds.');
  }
  if (!res.ok) throw new ApiError(res.status, `Ask Hale failed (${res.status}).`);

  const body = await res.text();
  let answer = '';
  let conversationId: string | null = null;
  let failed = false;
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const event = JSON.parse(trimmed) as CoachEvent;
    if (event.type === 'delta') answer += event.text;
    else if (event.type === 'reset') answer = '';
    else if (event.type === 'done') conversationId = event.conversationId;
    else failed = true;
  }
  if (failed) throw new ApiError(500, 'Ask Hale ran into a problem. Please try again.');
  return { answer, conversationId };
}
