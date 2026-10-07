/**
 * Group onboarding v2 — the one locked sentence in this flow.
 *
 * Every other group onboarding line is written by the model. When the model cannot
 * write one, nothing is sent and Slack #ops is paged. This sentence is the exception:
 * a STOP acknowledgement is carrier compliance, bilingual, and slot-free.
 */

export const GROUP_STOP_ACK_LOCKED =
  "Got it, I won't write to you in this group. / C'est compris, je ne vous écrirai plus dans ce groupe.";
