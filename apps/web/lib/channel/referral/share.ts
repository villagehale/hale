import { type RegisteredTool, defineTool } from '@hale/agent';
import { z } from 'zod';
import { smsEncoding, smsSegments } from '~/lib/channel/sms-segments';
import { referralLink } from './code';

/**
 * `share_referral_link` — the honest answer to "how do I tell a friend about this".
 *
 * THE INCIDENT THIS EXISTS FOR (founder's own thread, 2026-08-15 22:21 ET). A parent
 * asked how to refer others and Hale replied that "referral links live in your account
 * settings in the app". There was no referral feature, no account-settings page holding
 * one, and no link. Two invented facts in two sentences, both pointing at the app the
 * coach is forbidden to point at. The model was not being careless: it was asked a
 * question about Hale's own capabilities with NOTHING in the turn that knew the answer,
 * and a plausible-sounding place to put one was the only material it had.
 *
 * So the fix is not a better instruction. It is a fact: this tool. The capability the
 * parent asked about now EXISTS, the link is computed rather than remembered, and the
 * skill's rule for everything else is that a capability with no tool behind it is one
 * Hale does not have (see coach-channel-sms.md, "Questions about Hale itself").
 *
 * THE MODEL NEVER WRITES THE LINK. It writes the forwardable SENTENCE and hands it in;
 * the runtime appends `${forward} ${link}` after the answer has been fitted to the
 * segment budget. Three things fall out of that shape, and each one was a real failure
 * mode somewhere else on this surface:
 *
 *   A LINK CANNOT BE WRONG THAT WAS NEVER COMPOSED. The coach runtime deliberately
 *   holds no URL at all (runtime.ts) precisely so that a URL in a reply is provably
 *   invented. This tool is the ONE exception, and it stays an exception because the
 *   model is handed nothing to copy — the string is assembled outside its reach.
 *
 *   A LINK CANNOT BE TRIMMED THAT IS APPENDED AFTER THE TRIM. The plan-offer arc learnt
 *   this the hard way: a protected sentence written into the answer gets amputated by
 *   the segment budget, and half a link is worse than none.
 *
 *   THE VOICE STAYS HALE'S. A constant would be a preset body, which this product does
 *   not send. The model composes the line a friend will actually read; the gate below
 *   only refuses the shapes that must not be sent, and a refusal is a sentence the model
 *   reads mid-turn and answers by calling again.
 *
 * CASL. Nothing here sends anything to anyone. The parent forwards the message; the
 * friend's own first text is their consent, exactly as it is for a QR card. There is no
 * argument on this tool through which a phone number could be supplied.
 */

/** What the turn registered: the line the parent forwards, and the link that goes with
 * it. `link` is computed from the family id and is never a model argument. */
export interface ReferralShare {
  forward: string;
  link: string;
}

/**
 * The forwardable line's ceiling. The whole reply is two segments (306 GSM-7
 * characters); the link costs ~54 and the parent still needs a sentence of their own, so
 * this is what is left over rather than a round number.
 */
export const MAX_FORWARD_CHARS = 120;

/** The pointers that made the live fabrication, refused in code rather than discouraged
 * in prose. A forwarded line that names the app is the exact sentence this feature
 * replaces, and "settings" is where the invented referral page was said to live. */
const APP_POINTER = /\b(app|apps|settings|account|dashboard|website|download)\b/i;

/** Anything that looks like the model writing a URL. It is handed none, so a URL in the
 * forward line is either invented or a copy of one it was told not to repeat. */
const ANY_URL = /(https?:\/\/|www\.|villagehale|\.com\b|\.ca\b)/i;

/**
 * Everything wrong with a proposed forward line, phrased for the model that has to
 * rewrite it. An empty array means it may be sent.
 *
 * Exported so the eval holds the same bar without a second copy of the rules.
 */
export function forwardViolations(forward: string): string[] {
  const violations: string[] = [];
  const text = forward.trim();

  if (text === '') return ['The line was empty.'];
  if (text.length > MAX_FORWARD_CHARS) {
    violations.push(
      `The line is ${text.length} characters; it must be at most ${MAX_FORWARD_CHARS} so the link still fits beside it.`,
    );
  }
  if (ANY_URL.test(text)) {
    violations.push(
      'The line contains a link. Do not write one - the real link is added after your message, and any URL you compose is one you invented.',
    );
  }
  if (APP_POINTER.test(text)) {
    violations.push(
      'The line points at an app, a website or an account. Hale is a number their friend texts; there is nothing for them to open, download or sign up for.',
    );
  }
  if (smsEncoding(text) !== 'gsm7') {
    violations.push('The line contains a character that doubles the cost to send. Use plain ASCII.');
  }
  if (smsSegments(text) > 1) {
    violations.push('The line is longer than one SMS segment. Shorten it.');
  }
  return violations;
}

/** The finished block the runtime appends: the forwardable line, then the link. */
export function referralBlock(share: ReferralShare): string {
  return `${share.forward} ${share.link}`;
}

/**
 * The verb. Registered only when something is listening for what it produces (rule
 * #11): a share nobody collects is a parent told to forward a message that has no link
 * in it.
 */
export function shareReferralLinkTool(
  familyId: string,
  onShare: (share: ReferralShare) => void,
): RegisteredTool {
  return defineTool({
    name: 'share_referral_link',
    description:
      "Get this family's own link for telling somebody else about Hale — call it whenever a parent asks how to refer, invite, share, or recommend Hale to a friend, or asks whether there is a referral link. `forward` is the line THEY will forward to their friend, in your voice: what Hale is, at most 120 plain-ASCII characters, no link and nothing about this family. The real link is added onto the end of your message for you, so never write a URL yourself and never write the forwarded line twice. Nothing is sent to anyone by this tool — the parent forwards it, and their friend texting in is that friend's own consent.",
    inputSchema: z.object({ forward: z.string().min(1) }),
    inputExamples: [
      { forward: "It's a text line that keeps track of the family week - registrations, plans, the stuff that slips." },
    ],
    monetary: false,
    // `{shared:true}` and nothing else — the link is assembled by the runtime after the
    // fit, so the model has nothing to wait for and the loop ends on the message it
    // wrote beside this call (tool.ts registersOnly).
    registersOnly: true,
    // Names no child and reads no child row: the forwarded line is about Hale, and the
    // gate above is what keeps it that way.
    touchesChildContent: false,
    handler: async (input) => {
      // The gate IS the recompose loop, exactly as it is for offer_full_plan: a refusal
      // is thrown as a sentence the model reads and answers by calling again with a
      // better line. Nothing is registered until one passes, so the runtime can only
      // ever append a line that cleared every check.
      const violations = forwardViolations(input.forward);
      if (violations.length > 0) {
        throw new Error(
          `That line cannot be sent. ${violations.join(' ')} Call share_referral_link again with a fixed one.`,
        );
      }
      onShare({ forward: input.forward.trim(), link: referralLink(familyId) });
      return { shared: true as const };
    },
  });
}
