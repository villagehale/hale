/**
 * The batched fold of the coach NDJSON stream. RN's fetch has no readable body,
 * so askHale() reads the whole response text and folds the newline-delimited
 * events here, post-hoc. Split out from coach-api.ts so the fold is unit-testable
 * without a network round-trip.
 *
 * The answer is the concatenated `delta` text, cleared by a `reset` (an
 * intermediate tool turn whose text is NOT the answer), ended by `done` (carrying
 * the running conversationId). The activity trail is the settled `tool_result`
 * events — name + ok + a content-free preview only (rule #1: never args or raw
 * output; the server already redacted these). `step`/`tool_call` events are the
 * live-progress signals the web renders incrementally; in the batched mobile view
 * only the settled results matter, so they're dropped.
 */

/** One settled tool step in a turn's activity trail. Mirrors the web
 * `tool_result` event — name/ok/preview only (rule #1). */
export interface ActivityEvent {
  name: string;
  ok: boolean;
  preview: string;
}

type CoachEvent =
  | { type: 'step'; step: number }
  | { type: 'tool_call'; name: string }
  | { type: 'tool_result'; name: string; ok: boolean; preview: string }
  | { type: 'delta'; text: string }
  | { type: 'reset' }
  | { type: 'done'; conversationId: string }
  | { type: 'error' };

export interface CoachFold {
  answer: string;
  conversationId: string | null;
  activity: ActivityEvent[];
  failed: boolean;
}

export function foldCoachStream(body: string): CoachFold {
  let answer = '';
  let conversationId: string | null = null;
  let failed = false;
  const activity: ActivityEvent[] = [];

  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const event = JSON.parse(trimmed) as CoachEvent;
    if (event.type === 'delta') answer += event.text;
    else if (event.type === 'reset') answer = '';
    else if (event.type === 'done') conversationId = event.conversationId;
    else if (event.type === 'tool_result') {
      activity.push({ name: event.name, ok: event.ok, preview: event.preview });
    } else if (event.type === 'error') failed = true;
  }

  return { answer, conversationId, activity, failed };
}
