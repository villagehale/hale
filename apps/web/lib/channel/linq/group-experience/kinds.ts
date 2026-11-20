/**
 * VIL-399 — poll kinds Hale writes onto `linq_poll_options` for group RSVP
 * and time cards. Distinct from VIL-471 `group_poll` / `group_stuck`.
 *
 * Linq (https://docs.linqapp.com/channel/imessage/guides/messaging/polls/):
 * a partner can POST `/v3/chats/{id}/polls` from Hale's line, GET the tally,
 * and receive `poll.vote.added` / `poll.vote.removed`. Docs do not name an
 * iOS 26-only poll API. Link parts are a separate send
 * (https://docs.linqapp.com/channel/imessage/guides/messaging/rich-link-previews/).
 */
export const GROUP_RSVP_POLL_KIND = 'group_rsvp';
export const GROUP_TIME_POLL_KIND = 'group_time';
export const GROUP_EXPERIENCE_CHOICE_KIND = 'group_experience_option';

export function isGroupExperiencePollKind(pollKind: string | null): boolean {
  return pollKind === GROUP_RSVP_POLL_KIND || pollKind === GROUP_TIME_POLL_KIND;
}

export const GROUP_EXPERIENCE_TEMPLATE = 'linq:group_experience';
export const GROUP_EXPERIENCE_1TO1_TEMPLATE = 'linq:group_experience_1to1';
