import { canaryCaptureExtras } from '@hale/agent';
import type { PostHog } from 'posthog-node';
import { familyIsCanary } from './canary-family.js';
import { captureSafeException } from './exceptions.js';
import { errorTrackingEnabled, productEventsEnabled } from './flags.js';
import { hashTelemetryId, posthogIdSalt } from './identity.js';
import { productClient, projectClient } from './posthog.js';

/**
 * Worker-side launch events. Same hashing / flags / fire-and-forget as
 * apps/web/lib/analytics/product.ts. The worker cannot import from apps/web.
 */

export type CaptureOutcome = 'sent' | 'not_configured' | 'flag_off' | 'provider_error';

export type WorkerProductEvent = 'task_completed';
export type WorkerErrorEvent = 'turn_failed' | 'send_failed' | 'registration_run_failed';

const FORBIDDEN_KEY_FRAGMENTS = [
  'name',
  'email',
  'phone',
  'address',
  'dob',
  'birth',
  'child',
  'teen',
  'message',
  'content',
  'body',
  'text',
  'question',
  'answer',
  'note',
  'location',
  'lat',
  'lng',
  'postal',
  'ip',
  'token',
] as const;

function isForbiddenKey(key: string): boolean {
  const lower = key.toLowerCase();
  return FORBIDDEN_KEY_FRAGMENTS.some((fragment) => lower.includes(fragment));
}

function sanitize(properties: Record<string, unknown>): Record<string, string | number | boolean> {
  const safe: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (isForbiddenKey(key)) continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      safe[key] = value;
    }
  }
  return safe;
}

export interface WorkerEventInput {
  event: WorkerProductEvent | WorkerErrorEvent;
  familyId?: string | null;
  chatId?: string | null;
  properties?: Record<string, unknown>;
}

function groupsFor(familyHash: string | null, chatHash: string | null): Record<string, string> {
  const groups: Record<string, string> = {};
  if (familyHash) groups.family = familyHash;
  if (chatHash) groups.group_chat = chatHash;
  return groups;
}

async function send(
  client: PostHog,
  event: string,
  distinctId: string,
  properties: Record<string, unknown>,
  groups: Record<string, string>,
  isCanary: boolean,
): Promise<CaptureOutcome> {
  const extras = canaryCaptureExtras(isCanary, distinctId);
  const safe = sanitize({ ...properties, ...extras.event });
  const stamped: Record<string, unknown> = { ...safe };
  if (extras.set) stamped.$set = extras.set;
  if (Object.keys(groups).length > 0) stamped.$groups = groups;
  try {
    client.capture({
      distinctId,
      event,
      properties: stamped,
      ...(Object.keys(groups).length > 0 ? { groups } : {}),
    });
    await client.flush();
    return 'sent';
  } catch (err) {
    console.warn('analytics: worker event failed to send', {
      event,
      err: err instanceof Error ? err.name : 'unknown',
    });
    return 'provider_error';
  }
}

export async function captureProductEventAsync(input: WorkerEventInput): Promise<CaptureOutcome> {
  if (input.event !== 'task_completed') return 'not_configured';
  if (!productEventsEnabled()) return 'flag_off';
  if (!posthogIdSalt() || !input.familyId) return 'not_configured';
  const client = productClient();
  if (!client) return 'not_configured';
  const familyHash = hashTelemetryId(input.familyId);
  if (!familyHash) return 'not_configured';
  const chatHash = input.chatId ? hashTelemetryId(input.chatId) : null;
  const isCanary = await familyIsCanary(input.familyId);
  return send(
    client,
    input.event,
    familyHash,
    input.properties ?? {},
    groupsFor(familyHash, chatHash),
    isCanary,
  );
}

export function captureProductEvent(input: WorkerEventInput): void {
  void captureProductEventAsync(input);
}

export async function captureErrorEventAsync(input: WorkerEventInput): Promise<CaptureOutcome> {
  if (input.event === 'task_completed') return 'not_configured';
  if (!errorTrackingEnabled()) return 'flag_off';
  if (!posthogIdSalt() || !input.familyId) return 'not_configured';
  const client = productClient() ?? projectClient();
  if (!client) return 'not_configured';
  const familyHash = hashTelemetryId(input.familyId);
  if (!familyHash) return 'not_configured';
  const chatHash = input.chatId ? hashTelemetryId(input.chatId) : null;
  const isCanary = await familyIsCanary(input.familyId);
  const outcome = await send(
    client,
    input.event,
    familyHash,
    input.properties ?? {},
    groupsFor(familyHash, chatHash),
    isCanary,
  );
  const synthetic = new Error('redacted');
  synthetic.name = `Hale_${input.event}`;
  void captureSafeException(
    synthetic,
    familyHash,
    {
      hale_surface: 'worker',
      stage: input.event,
    },
    { canary: isCanary },
  );
  return outcome;
}

export function captureErrorEvent(input: WorkerEventInput): void {
  void captureErrorEventAsync(input);
}
