import { type EnvBag, isEnabled } from '@hale/flags';
import { type SpokenLineRequest, speak } from '~/lib/channel/spoken-line';

/**
 * VIL-706 · co-parent join and caregiver doors.
 *
 * Linq only. The model writes the whole line from the facts, through the spoken-line
 * writer with the `door-line` addendum (packages/agent/skills/door-line.md). There is no
 * template, skeleton or fallback sentence, and a line that names STOP, HELP, ARRET or
 * AIDE is refused like a stray link. A line the model does not write is not sent. The
 * writer has already paged #ops (`spoken_line_unwritten`) by the time it returns nothing,
 * so this module pages nobody a second time. A seat change is already recorded by the
 * caller, and the caller names the held line in its outcome (`lineHeld`, `welcomeHeld`,
 * `inviterHeld`) instead of reporting a send. The join link is the one line written
 * first: the model writes a `[[link]]` slot, and a held line leaves no link at all.
 *
 * Dark unless `JOIN_DOOR_MODEL_COPY_ENABLED` is exactly `true`. Dark, these lines are not
 * sent at all: the fixed sentences they replaced (two of which taught STOP) are deleted,
 * not kept as the flag-off answer.
 */

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

/** Why a door line did not go out. Named, never inferred (rule #11). */
export type DoorLineHold = 'flag_off' | 'unwritten';

export type ComposedDoorLine = { sent: true; body: string } | { sent: false; held: DoorLineHold };

export interface DoorLineRequest
  extends Omit<SpokenLineRequest, 'purpose' | 'addendum' | 'refuseOptOutKeyword'> {
  purpose: DoorLinePurpose;
}

export function lineHeld(line: ComposedDoorLine): DoorLineHold | null {
  return line.sent ? null : line.held;
}

export function joinDoorModelCopyEnabled(env: EnvBag = process.env): boolean {
  return isEnabled('join-door-model-copy', undefined, env);
}

/** The line for one door moment, or the named reason it is held. Sends nothing itself. */
export async function composeDoorLine(request: DoorLineRequest): Promise<ComposedDoorLine> {
  if (!joinDoorModelCopyEnabled()) {
    console.info(
      { purpose: request.purpose, skipped: 'flag_off' },
      'door line: model copy is dark - nothing sent',
    );
    return { sent: false, held: 'flag_off' };
  }
  const line = await speak({ ...request, addendum: 'door-line' });
  if (line) return { sent: true, body: line };
  console.error({ purpose: request.purpose }, 'door line: model wrote nothing - nothing sent');
  return { sent: false, held: 'unwritten' };
}
