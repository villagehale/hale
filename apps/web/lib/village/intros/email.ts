import type { FamilyStage } from '@hale/types';
import { RESEND_DEFAULT_FROM } from '~/lib/channel/adapters/resend-email';
import { type ResendTransport, createResendTransport } from '~/lib/channel/resend-transport';
import { INTRO_EMAIL_SUBJECT, introEmailBody } from './copy';

/**
 * Village intros v1 — the handoff.
 *
 * ONE EMAIL, BOTH PARENTS ON THE VISIBLE HEADER. That shape is the feature, not a
 * delivery detail: two separate emails would be Hale relaying between two people who
 * still have not met, which is a job Hale would then be stuck doing forever. One thread
 * they can both reply-all to is the moment Hale can leave, and the last line of the
 * body says so out loud.
 *
 * It is also why this needs no inbound-email leg to work. Whatever the two parents say
 * next happens between them, on their own mail servers, with Hale as a name in the
 * From line and nothing more.
 */

export interface IntroEmailRequest {
  parentA: { firstName: string; email: string };
  parentB: { firstName: string; email: string };
  stage: FamilyStage;
  /** Verbatim from the civic_sessions row, or null when the pair had no anchor. */
  anchorTitle: string | null;
}

/**
 * What happened, always in the return value.
 *
 * `not_configured` is a first-class outcome rather than a silent success (rule #11).
 * The shared Resend transport no-ops when it has no API key and reports {id:null,
 * error:null} — which reads as "sent" to anyone who only checks `error`. An intro that
 * silently did not send is the worst failure this feature has: both families said yes,
 * both get audited as disclosed-to, and neither ever hears from the other. So the
 * key is checked BEFORE the send and the skip is named.
 */
export type IntroEmailResult =
  | { status: 'sent'; providerMessageId: string | null }
  | { status: 'skipped'; reason: 'not_configured' }
  | { status: 'error'; message: string };

export interface IntroEmailSender {
  send(request: IntroEmailRequest): Promise<IntroEmailResult>;
}

export interface IntroEmailSenderDeps {
  transport?: ResendTransport;
  /** Whether Resend is reachable; defaults to the presence of RESEND_API_KEY. */
  configured?: boolean;
  from?: string;
}

export function createIntroEmailSender(deps: IntroEmailSenderDeps = {}): IntroEmailSender {
  const transport =
    deps.transport ?? createResendTransport({ apiKey: process.env.RESEND_API_KEY });
  return {
    async send(request) {
      if (!(deps.configured ?? Boolean(process.env.RESEND_API_KEY))) {
        return { status: 'skipped', reason: 'not_configured' };
      }

      const { id, error } = await transport.send({
        from: deps.from ?? process.env.RESEND_FROM ?? RESEND_DEFAULT_FROM,
        to: request.parentA.email,
        cc: request.parentB.email,
        subject: INTRO_EMAIL_SUBJECT,
        text: introEmailBody({
          parentAFirstName: request.parentA.firstName,
          parentBFirstName: request.parentB.firstName,
          stage: request.stage,
          anchorTitle: request.anchorTitle,
        }),
      });

      if (error) return { status: 'error', message: error.message };
      return { status: 'sent', providerMessageId: id };
    },
  };
}

/** The first name Hale uses for a parent in the intro.
 *
 * FIRST NAMES ONLY, on both sides — a surname is an identity a parent can be looked up
 * by, and nobody consented to that. `users.name` is a display name a parent typed, so
 * the first whitespace-delimited token is their first name; a single-token name is
 * already one. */
export function introFirstName(displayName: string): string {
  return displayName.trim().split(/\s+/)[0] ?? displayName.trim();
}
