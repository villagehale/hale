import type { Database } from '@hale/db';
import { type EnvBag, isEnabled } from '@hale/flags';
import { type SpokenLineRequest, speak } from '~/lib/channel/spoken-line';
import { type OpsPage, type OpsPager, pageOps } from '~/lib/monitoring/failure-page';

/**
 * VIL-706 · co-parent join and caregiver doors.
 *
 * Linq only. The model writes the whole parent-visible line from the facts,
 * through the spoken-line composer. There is no template, skeleton, or
 * fallback sentence. A line the model does not write is not sent, and #ops
 * is paged. The seat change is already recorded by the caller.
 *
 * Dark unless `JOIN_DOOR_MODEL_COPY_ENABLED` is exactly `true`.
 */

export const JOIN_DOOR_MODEL_COPY_ENV = 'JOIN_DOOR_MODEL_COPY_ENABLED';

export const DOOR_LINE_PURPOSES = [
  'join_invite_forward',
  'join_welcome',
  'join_accepted_ack',
  'caregiver_welcome',
  'caregiver_decline_ack',
  'caregiver_invite_sent',
  'caregiver_invite_dropped',
  'caregiver_add_example',
  'caregiver_co_parent_redirect',
  'caregiver_number_in_use',
  'caregiver_own_number',
  'caregiver_already_invited',
  'caregiver_cannot_text',
  'caregiver_too_many',
  'caregiver_scoped_reply',
] as const;

export type DoorLinePurpose = (typeof DOOR_LINE_PURPOSES)[number];

/** Why a parent-visible door line did not go out. Named, never inferred (rule #11). */
export type DoorLineHold = 'flag_off' | 'unwritten';

export type ComposedDoorLine = { sent: true; body: string } | { sent: false; held: DoorLineHold };

export function lineHeld(line: ComposedDoorLine): DoorLineHold | null {
  return line.sent ? null : line.held;
}

export function joinDoorModelCopyEnabled(env: EnvBag = process.env): boolean {
  return isEnabled('join-door-model-copy', undefined, env);
}

export async function composeDoorLine(
  database: Database,
  request: SpokenLineRequest,
  pager?: OpsPager,
): Promise<ComposedDoorLine> {
  if (!joinDoorModelCopyEnabled()) {
    console.info(
      { purpose: request.purpose, skipped: 'flag_off' },
      'door line: model copy is dark - nothing sent',
    );
    return { sent: false, held: 'flag_off' };
  }
  const line = await speak(request);
  if (line) return { sent: true, body: line };
  console.error({ purpose: request.purpose }, 'door line: model wrote nothing - nothing sent');
  const page: OpsPage = { site: 'spoken_line_unwritten', facts: { stage: 'after_retry' } };
  await (pager ?? { page: (opsPage: OpsPage) => pageOps(database, opsPage) }).page(page);
  return { sent: false, held: 'unwritten' };
}
