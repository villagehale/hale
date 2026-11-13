import type { PostHog } from 'posthog-node';
import { type AnalyticsEvent, buildEvent } from './events';
import { captureSafeException } from './exceptions';
import { errorTrackingEnabled, productEventsEnabled } from './flags';
import { hashTelemetryId, posthogIdSalt } from './identity';
import { productClient, projectClient } from './posthog-node';

/**
 * Launch product + error events. Fire-and-forget: a caller must never await this on
 * a parent-reply path. Distinct id is HMAC-SHA256(family id, POSTHOG_ID_SALT). Group
 * analytics uses type `family` (same hash) and, for a Linq group chat, `group_chat`.
 *
 * Inert unless the matching flag is exactly `true` AND the salt AND a PostHog key
 * are set. Never throws.
 */

export type CaptureOutcome = 'sent' | 'not_configured' | 'flag_off' | 'provider_error';

export type ProductChannel = 'imessage' | 'sms' | 'group' | 'email';

export type TaskType =
  | 'registration'
  | 'carpool'
  | 'calendar_change'
  | 'rsvp'
  | 'reminder'
  | 'email_action';

const PRODUCT_EVENTS = new Set<AnalyticsEvent>([
  'message_inbound',
  'message_outbound',
  'task_completed',
  'group_chat_created',
  'group_chat_member_added',
  'onboarding_step',
  'onboarding_completed',
  'family_signed_up',
]);

const ERROR_EVENTS = new Set<AnalyticsEvent>([
  'send_failed',
  'message_unanswered',
  'turn_failed',
  'registration_run_failed',
]);

let saltAbsenceLogged = false;
let productFlagAbsenceLogged = false;
let errorFlagAbsenceLogged = false;

export function resetProductCaptureLogsForTests(): void {
  saltAbsenceLogged = false;
  productFlagAbsenceLogged = false;
  errorFlagAbsenceLogged = false;
}

export function productChannel(args: {
  channel: string;
  isGroup?: boolean | null;
}): ProductChannel {
  if (args.channel === 'email') return 'email';
  if (args.isGroup === true) return 'group';
  if (args.channel === 'imessage') return 'imessage';
  return 'sms';
}

export function mediaKindOf(parts: ReadonlyArray<{ kind: string }> | null | undefined): string {
  if (!parts || parts.length === 0) return 'none';
  if (parts.length === 1) return parts[0]?.kind ?? 'none';
  return 'mixed';
}

export interface ProductEventInput {
  event: AnalyticsEvent;
  familyId?: string | null;
  /** Pre-family intake: hashed session id stands in until a family exists. */
  sessionId?: string | null;
  chatId?: string | null;
  properties?: Record<string, unknown>;
}

function groupsFor(familyHash: string | null, chatHash: string | null): Record<string, string> {
  const groups: Record<string, string> = {};
  if (familyHash) groups.family = familyHash;
  if (chatHash) groups.group_chat = chatHash;
  return groups;
}

function distinctFor(input: ProductEventInput): { distinctId: string; familyHash: string | null } | null {
  if (input.familyId) {
    const familyHash = hashTelemetryId(input.familyId);
    if (!familyHash) return null;
    return { distinctId: familyHash, familyHash };
  }
  if (input.sessionId) {
    const sessionHash = hashTelemetryId(input.sessionId);
    if (!sessionHash) return null;
    return { distinctId: sessionHash, familyHash: null };
  }
  return null;
}

async function send(
  client: PostHog,
  event: AnalyticsEvent,
  distinctId: string,
  properties: Record<string, unknown>,
  groups: Record<string, string>,
): Promise<CaptureOutcome> {
  const { event: name, properties: safe } = buildEvent(event, properties);
  try {
    client.capture({
      distinctId,
      event: name,
      properties: Object.keys(groups).length > 0 ? { ...safe, $groups: groups } : safe,
      ...(Object.keys(groups).length > 0 ? { groups } : {}),
    });
    await client.flush();
    return 'sent';
  } catch (err) {
    console.warn('analytics: product event failed to send', {
      event: name,
      err: err instanceof Error ? err.name : 'unknown',
    });
    return 'provider_error';
  }
}

function noteSaltMissing(): void {
  if (saltAbsenceLogged) return;
  saltAbsenceLogged = true;
  console.warn(
    'analytics: POSTHOG_ID_SALT is not set — launch product/error events will not be recorded',
  );
}

function noteProductFlagOff(): void {
  if (productFlagAbsenceLogged) return;
  productFlagAbsenceLogged = true;
  console.warn(
    'analytics: POSTHOG_PRODUCT_EVENTS_ENABLED is not true — launch product events stay dark',
  );
}

function noteErrorFlagOff(): void {
  if (errorFlagAbsenceLogged) return;
  errorFlagAbsenceLogged = true;
  console.warn(
    'analytics: POSTHOG_ERROR_TRACKING_ENABLED is not true — launch error events stay dark',
  );
}

/** Awaitable send, for tests. Production call sites use {@link captureProductEvent}. */
export async function captureProductEventAsync(input: ProductEventInput): Promise<CaptureOutcome> {
  if (!PRODUCT_EVENTS.has(input.event)) return 'not_configured';
  if (!productEventsEnabled()) {
    noteProductFlagOff();
    return 'flag_off';
  }
  if (!posthogIdSalt()) {
    noteSaltMissing();
    return 'not_configured';
  }
  const client = productClient();
  if (!client) return 'not_configured';
  const ids = distinctFor(input);
  if (!ids) {
    noteSaltMissing();
    return 'not_configured';
  }
  const chatHash = input.chatId ? hashTelemetryId(input.chatId) : null;
  return send(
    client,
    input.event,
    ids.distinctId,
    input.properties ?? {},
    groupsFor(ids.familyHash, chatHash),
  );
}

/** Fire-and-forget. Never throws; the parent reply must not wait. */
export function captureProductEvent(input: ProductEventInput): void {
  void captureProductEventAsync(input);
}

export async function captureErrorEventAsync(input: ProductEventInput): Promise<CaptureOutcome> {
  if (!ERROR_EVENTS.has(input.event)) return 'not_configured';
  if (!errorTrackingEnabled()) {
    noteErrorFlagOff();
    return 'flag_off';
  }
  if (!posthogIdSalt()) {
    noteSaltMissing();
    return 'not_configured';
  }
  const client = productClient() ?? projectClient();
  if (!client) return 'not_configured';
  const ids = distinctFor(input);
  if (!ids) {
    noteSaltMissing();
    return 'not_configured';
  }
  const chatHash = input.chatId ? hashTelemetryId(input.chatId) : null;
  const outcome = await send(
    client,
    input.event,
    ids.distinctId,
    input.properties ?? {},
    groupsFor(ids.familyHash, chatHash),
  );
  const synthetic = new Error('redacted');
  synthetic.name = `Hale_${input.event}`;
  void captureSafeException(synthetic, ids.distinctId, {
    hale_surface: 'agent',
    stage: input.event,
    code: String(input.properties?.stage ?? input.properties?.reason ?? input.event),
  });
  return outcome;
}

export function captureErrorEvent(input: ProductEventInput): void {
  void captureErrorEventAsync(input);
}
