import { fetch } from 'expo/fetch';

import { API_BASE, ApiError, signalUnauthorized } from './api-client';
import {
  type ActionIntent,
  type ActivityEvent,
  type CoachEvent,
  createNdjsonSplitter,
} from './coach-fold';
import { TOKEN_KEY, tokenStorage } from './token-storage';

/**
 * Ask Hale over POST /api/coach — a TRULY streaming transport. Expo SDK 56's
 * `expo/fetch` exposes a readable response body (native didReceiveResponseData →
 * ReadableStream), which RN's built-in fetch does not; we read it with
 * response.body.getReader(), decode each chunk, split the newline-delimited events
 * as they arrive (createNdjsonSplitter), and fire the callbacks LIVE so the screen
 * shows the step trail forming and the answer growing token-by-token — the agentic
 * feel — instead of downloading the whole answer and typing it out post-hoc.
 *
 * Rule #1 unchanged: tool events carry name/ok/preview only — the server already
 * redacted args and raw output; this client never re-derives them.
 */

export type { ActionIntent, ActivityEvent, ToolCard } from './coach-fold';

/** Live callbacks fired as the stream arrives. Every one is optional; the screen
 * wires the ones it renders. `onReset` clears an intermediate tool turn's text (not
 * the answer); `onDone` carries the running conversationId. */
export interface CoachStreamHandlers {
  onStep?: (step: number) => void;
  onToolCall?: (name: string) => void;
  onToolResult?: (event: ActivityEvent) => void;
  onDelta?: (text: string) => void;
  onReset?: () => void;
  onActionIntents?: (intents: ActionIntent[]) => void;
  onDone?: (conversationId: string) => void;
}

export interface AskHaleRequest {
  question: string;
  conversationId?: string;
  intent?: string;
  focusedChildId?: string;
}

function dispatch(event: CoachEvent, handlers: CoachStreamHandlers): boolean {
  switch (event.type) {
    case 'delta':
      handlers.onDelta?.(event.text);
      return false;
    case 'step':
      handlers.onStep?.(event.step);
      return false;
    case 'tool_call':
      handlers.onToolCall?.(event.name);
      return false;
    case 'tool_result':
      handlers.onToolResult?.({
        name: event.name,
        ok: event.ok,
        preview: event.preview,
        ...(event.card ? { card: event.card } : {}),
      });
      return false;
    case 'reset':
      handlers.onReset?.();
      return false;
    case 'done':
      handlers.onActionIntents?.(event.actionIntents ?? []);
      handlers.onDone?.(event.conversationId);
      return false;
    default:
      // An `error` event: the agent run failed mid-stream — signal the caller.
      return true;
  }
}

/**
 * Stream the answer, firing `handlers` for each event as it arrives. Rejects with
 * an ApiError on a transport/auth/rate-limit failure or a mid-stream `error` event,
 * so the screen shows its retry state rather than a half-finished bubble.
 */
export async function askHale(req: AskHaleRequest, handlers: CoachStreamHandlers): Promise<void> {
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
  if (!res.ok || !res.body) throw new ApiError(res.status, `Concierge failed (${res.status}).`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const splitter = createNdjsonSplitter();
  let failed = false;

  const drain = (events: CoachEvent[]) => {
    for (const event of events) {
      if (dispatch(event, handlers)) failed = true;
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      drain(splitter.push(decoder.decode(value, { stream: true })));
    }
    drain(splitter.flush());
  } catch {
    throw new ApiError(0, 'Concierge lost its connection mid-answer. Please try again.');
  }

  if (failed) throw new ApiError(500, 'Concierge ran into a problem. Please try again.');
}
