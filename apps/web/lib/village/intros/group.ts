import { isEnabled } from '@hale/flags';
import { LinqSendError } from '~/lib/channel/linq/transport';
import {
  createLinqChat,
  outboundLineFrom,
  sendMayHaveLanded,
} from '~/lib/channel/outbound-transport';

/**
 * The village introduction as a three-way iMessage group: Hale opens one Linq chat with
 * both parents, and its first message is the composed introduction (group-voice.ts).
 *
 * Off unless `VILLAGE_INTRO_GROUPS_ENABLED` is exactly `true`. Dark, a fully accepted
 * pair waits with the named `no_intro_channel` outcome, as it has since email retired.
 *
 * Once the group is open Hale is out of it: the inbound door sees a chat holding two
 * families and takes the `group_mixed_family` hold, which sends nothing.
 */

export const INTRO_GROUP_TEMPLATE_KEY = 'village_intro:group';

export function villageIntroGroupsEnabled(): boolean {
  return isEnabled('village-intro-groups');
}

/** One dedupe key per side, so each family's ledger carries its own row. */
export function introGroupDedupeKey(proposalId: string, side: 'a' | 'b'): string {
  return `${INTRO_GROUP_TEMPLATE_KEY}:${proposalId}:${side}`;
}

/** Marks a pair whose group Linq may have opened, so no sweep opens a second one. */
export function introGroupUnconfirmedKey(proposalId: string): string {
  return `${INTRO_GROUP_TEMPLATE_KEY}:${proposalId}:unconfirmed`;
}

/** First names only, on both sides: a surname is an identity a parent can be looked up
 * by, and nobody consented to that. */
export function introFirstName(displayName: string): string {
  return displayName.trim().split(/\s+/)[0] ?? displayName.trim();
}

export type OpenIntroGroupResult =
  | { status: 'opened'; chatId: string; providerMessageId: string }
  /** No Linq line in this environment — named, never a silent skip (rule #11). */
  | { status: 'not_configured' }
  | { status: 'refused'; code: string; permanent: boolean; mayHaveLanded?: true };

export type OpenIntroGroup = (input: {
  to: readonly [string, string];
  text: string;
}) => Promise<OpenIntroGroupResult>;

export function createLinqIntroGroupOpener(deps: { fetch?: typeof fetch } = {}): OpenIntroGroup {
  return async ({ to, text }) => {
    const from = outboundLineFrom();
    if (!from) return { status: 'not_configured' };
    try {
      const opened = await createLinqChat({ from, to, text, fetch: deps.fetch });
      return { status: 'opened', ...opened };
    } catch (err) {
      const landed = sendMayHaveLanded(err) ? ({ mayHaveLanded: true } as const) : {};
      if (err instanceof LinqSendError) {
        return { status: 'refused', code: err.code, permanent: err.permanent, ...landed };
      }
      if (landed.mayHaveLanded) {
        return { status: 'refused', code: 'unknown', permanent: false, ...landed };
      }
      throw err;
    }
  };
}
