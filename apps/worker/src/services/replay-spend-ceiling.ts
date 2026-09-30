import { createHash } from 'node:crypto';
import { ingestedEventPayloadSchema } from '@hale/tools-contracts';

/**
 * Select `events.ingested` jobs to replay after a hard-ceiling drop.
 *
 * A drop writes `event.dropped.spend_ceiling` and completes the job. It does
 * not leave an events row and it does not fail the job, so a failed-job retry
 * cannot see it. The window is the earliest such audit through 30s after the
 * latest. Jobs whose payload already became an events row (dedup hash, or the
 * same source plus canonical JSON) are left out.
 *
 * Pure. The script in apps/worker/scripts/replay-spend-ceiling.ts does the
 * reads and, only with --apply, the enqueue. Nothing schedules this.
 */

export const REPLAY_WINDOW_BUFFER_MS = 30_000;

/** Matches HOT_QUEUE_EXPIRE_SECONDS in apps/web/lib/cron/drain.ts. */
export const REPLAY_EXPIRE_IN_SECONDS = 900;

export const EVENTS_INGESTED_QUEUE = 'events.ingested';

export const SPEND_CEILING_DROP_VERB = 'event.dropped.spend_ceiling';

export interface ReplayAudit {
  occurredAt: Date;
}

export interface ReplayJobRow {
  id: string;
  completedOn: Date;
  data: unknown;
}

export interface ReplayStoredEvent {
  source: string;
  dedupHash: string;
  payload: unknown;
}

export interface ReplayCandidate {
  id: string;
  source: string;
  data: {
    family_id: string;
    source: string;
    payload: Record<string, unknown>;
    received_at: string;
  };
}

export interface ReplaySelection {
  candidates: ReplayCandidate[];
  alreadyRecorded: number;
  unreadable: number;
  outsideWindow: number;
}

export function replayWindow(audits: ReplayAudit[]): { start: Date; end: Date } | null {
  if (audits.length === 0) return null;
  let min = audits[0]?.occurredAt.getTime() ?? Number.NaN;
  let max = min;
  for (const audit of audits) {
    const at = audit.occurredAt.getTime();
    if (at < min) min = at;
    if (at > max) max = at;
  }
  if (Number.isNaN(min)) return null;
  return { start: new Date(min), end: new Date(max + REPLAY_WINDOW_BUFFER_MS) };
}

/** Stable JSON so jsonb key order does not hide a payload that was already stored. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function dedupHash(familyId: string, source: string, payload: Record<string, unknown>): string {
  const raw = JSON.stringify(payload);
  return createHash('sha256').update(`${familyId}|${source}|${raw}`).digest('hex');
}

/**
 * Jobs inside the audit window that have no matching events row. Unreadable
 * payloads are counted and skipped. The same job id from job and archive is
 * kept once.
 */
export function selectReplayCandidates(input: {
  familyId: string;
  audits: ReplayAudit[];
  jobs: ReplayJobRow[];
  storedEvents: ReplayStoredEvent[];
}): ReplaySelection {
  const window = replayWindow(input.audits);
  const empty: ReplaySelection = {
    candidates: [],
    alreadyRecorded: 0,
    unreadable: 0,
    outsideWindow: 0,
  };
  if (!window) return empty;

  const hashes = new Set(input.storedEvents.map((event) => event.dedupHash));
  const canonicalKeys = new Set(
    input.storedEvents.map((event) => `${event.source}|${canonicalJson(event.payload)}`),
  );

  const seen = new Set<string>();
  const selection = empty;

  for (const job of input.jobs) {
    if (seen.has(job.id)) continue;
    seen.add(job.id);
    const at = job.completedOn.getTime();
    if (at < window.start.getTime() || at > window.end.getTime()) {
      selection.outsideWindow += 1;
      continue;
    }
    const parsed = ingestedEventPayloadSchema.safeParse(job.data);
    if (!parsed.success || parsed.data.family_id !== input.familyId) {
      selection.unreadable += 1;
      continue;
    }
    const hash = dedupHash(input.familyId, parsed.data.source, parsed.data.payload);
    const key = `${parsed.data.source}|${canonicalJson(parsed.data.payload)}`;
    if (hashes.has(hash) || canonicalKeys.has(key)) {
      selection.alreadyRecorded += 1;
      continue;
    }
    selection.candidates.push({
      id: job.id,
      source: parsed.data.source,
      data: parsed.data,
    });
  }

  return selection;
}

/** id and source only. Payload bodies stay off the log (rule #1). */
export function replayCandidateLines(candidates: ReplayCandidate[]): string[] {
  return candidates.map((candidate) => `${candidate.id} ${candidate.source}`);
}
