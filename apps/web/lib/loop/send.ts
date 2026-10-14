/** The founder's send kill-switch: the loop composes but never sends until this is
 * explicitly 'true'. */
export function loopSendEnabled(): boolean {
  return process.env.LOOP_SEND_ENABLED === 'true';
}
