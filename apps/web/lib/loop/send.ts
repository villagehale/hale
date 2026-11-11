/** The founder's send kill-switch: the loop composes but never sends until this is
 * explicitly 'true'. */
import { isEnabled } from '@hale/flags';

export function loopSendEnabled(): boolean {
  return isEnabled('loop-send');
}
