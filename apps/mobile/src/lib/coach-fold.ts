/**
 * The pure line-parsing core of the coach NDJSON stream. The transport
 * (coach-api.ts) reads response.body.getReader() and feeds decoded chunks here as
 * they arrive; this splits them into complete newline-delimited events across
 * arbitrary chunk boundaries and hands each one back so the UI can react LIVE
 * (a step appears, a tool settles, the answer grows token-by-token). Split out so
 * the parse is unit-testable without a native streaming round-trip.
 *
 * The event grammar mirrors the web: `delta` text is the streamed answer, cleared
 * by a `reset` (an intermediate tool turn whose text is NOT the answer), ended by
 * `done` (carrying the running conversationId + gated actionIntents). `tool_result`
 * events carry name + ok + a content-free preview only (rule #1: never args or raw
 * output; the server already redacted these). `step`/`tool_call` are live-progress
 * signals.
 */

/**
 * A whitelisted display card a connector read tool attached to its result. Mirrors
 * the server `ToolCard` (packages/agent) — the ONE structured payload the firewall
 * lets through, a closed union of connector rows the tool declared display-safe
 * (rule #1: never file content, attendees, or a token). Re-declared here because
 * the mobile app takes no @hale/* workspace dep (it talks to the API over HTTP).
 */
export type ToolCard =
  | {
      kind: 'drive';
      files: Array<{
        name: string;
        mimeType: string;
        modifiedTime: string;
        webViewLink: string;
      }>;
    }
  | {
      kind: 'calendar';
      events: Array<{ title: string; start: string; end: string; location?: string }>;
    }
  | { kind: 'not_connected'; provider: 'gdrive' | 'gcal' };

/** One settled tool step in a turn's activity trail. Mirrors the web
 * `tool_result` event — name/ok/preview only (rule #1), plus an optional
 * whitelisted `card` when a connector read tool attached one. */
export interface ActivityEvent {
  name: string;
  ok: boolean;
  preview: string;
  card?: ToolCard;
}

/** Friendly, parent-facing label for a tool the concierge ran — so the trail reads
 * "Read your child’s profile" instead of the raw snake_case "get_child_profile"
 * (which also wrapped mid-word to "get_child_ profile" on a phone). Unknown tools
 * fall back to a de-snake-cased, sentence-cased form so a new tool never leaks raw. */
const TOOL_LABELS: Record<string, string> = {
  search_village: 'Searched your village',
  get_child_profile: 'Read your child’s profile',
  get_framework_guidance: 'Checked parenting guidance',
  search_memory: 'Searched your history',
  save_memory: 'Saved a note',
  drive_search: 'Searched your Google Drive',
  calendar_lookup: 'Checked your calendar',
};

export function humanizeTool(name: string): string {
  const known = TOOL_LABELS[name];
  if (known) return known;
  const words = name.replace(/_/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A gated action chip the answer implied — a DRAFT, never an auto-action (rule
 * #4). Mirrors the web ActionIntent: kind/label/actionType only, and only `label`
 * is ever rendered (rule #1: already content-safe, never the raw payload). */
export interface ActionIntent {
  kind: string;
  label: string;
  actionType: string;
}

export type CoachEvent =
  | { type: 'step'; step: number }
  | { type: 'tool_call'; name: string }
  | { type: 'tool_result'; name: string; ok: boolean; preview: string; card?: ToolCard }
  | { type: 'delta'; text: string }
  | { type: 'reset' }
  | { type: 'done'; conversationId: string; actionIntents?: ActionIntent[] }
  | { type: 'error' };

/**
 * A stateful splitter that turns a stream of arbitrarily-chunked NDJSON text into
 * complete events. A single JSON line can split across two `push` calls (or two
 * lines can arrive in one chunk), so it buffers the trailing partial line until a
 * newline completes it. Blank lines are ignored. Call `flush()` at end-of-stream
 * to emit a final unterminated line (the server ends each event with `\n`, so this
 * is normally empty, but it keeps the parse total).
 */
export function createNdjsonSplitter(): {
  push: (chunk: string) => CoachEvent[];
  flush: () => CoachEvent[];
} {
  let buffer = '';

  const parseLine = (line: string): CoachEvent | null => {
    const trimmed = line.trim();
    if (!trimmed) return null;
    return JSON.parse(trimmed) as CoachEvent;
  };

  return {
    push(chunk: string): CoachEvent[] {
      buffer += chunk;
      const events: CoachEvent[] = [];
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const event = parseLine(buffer.slice(0, newline));
        if (event) events.push(event);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
      }
      return events;
    },
    flush(): CoachEvent[] {
      const event = parseLine(buffer);
      buffer = '';
      return event ? [event] : [];
    },
  };
}

export interface CoachFold {
  answer: string;
  conversationId: string | null;
  activity: ActivityEvent[];
  actionIntents: ActionIntent[];
  failed: boolean;
}

/**
 * Fold a settled sequence of events into the final turn state — the assembled
 * answer, the running conversationId, the settled activity trail, and the gated
 * action chips. Pure over the ordered event list, so it's the same reducer whether
 * the events arrived one chunk at a time or all at once.
 */
export function foldCoachEvents(events: Iterable<CoachEvent>): CoachFold {
  let answer = '';
  let conversationId: string | null = null;
  let failed = false;
  const activity: ActivityEvent[] = [];
  let actionIntents: ActionIntent[] = [];

  for (const event of events) {
    if (event.type === 'delta') answer += event.text;
    else if (event.type === 'reset') answer = '';
    else if (event.type === 'done') {
      conversationId = event.conversationId;
      actionIntents = event.actionIntents ?? [];
    } else if (event.type === 'tool_result') {
      activity.push({
        name: event.name,
        ok: event.ok,
        preview: event.preview,
        ...(event.card ? { card: event.card } : {}),
      });
    } else if (event.type === 'error') failed = true;
  }

  return { answer, conversationId, activity, actionIntents, failed };
}

/**
 * Fold a whole NDJSON body at once — the batch convenience over the same splitter +
 * reducer the live transport uses, so both paths share one parse. Used where the
 * full body is already in hand (and by the unit tests).
 */
export function foldCoachStream(body: string): CoachFold {
  const splitter = createNdjsonSplitter();
  return foldCoachEvents([...splitter.push(body), ...splitter.flush()]);
}
