/**
 * VIL-353 · the evening check-in lane's names in the message ledger.
 *
 * These are FACTS the reply lane reads back off a `channel_messages` row, never words a
 * parent sees. `checkin:ask` OPENS a standing question; `checkin:weekly` announces a
 * cadence change and asks nothing; `checkin:ack` is every answer the lane sends back.
 *
 * One key for every ack, because the only question anyone asks of it is "was the last
 * thing this parent heard from Hale ours" — a reply row is written by the router, and
 * without a name on it the lane's own last word would be indistinguishable from the
 * coach's (reply.ts, `lastCheckInMessageToParent`).
 */
export const CHECK_IN_ASK_TEMPLATE_KEY = 'checkin:ask';
export const CHECK_IN_STEP_DOWN_TEMPLATE_KEY = 'checkin:weekly';
export const CHECK_IN_ACK_TEMPLATE_KEY = 'checkin:ack';
