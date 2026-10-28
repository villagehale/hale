import type {
  EmailAlertNotice,
  EmailAlertNoticeFacts,
} from '~/lib/integrations/email-alert-notice';
import type { FamilyChildRef } from '~/lib/sentinel';

/**
 * The email-alert writer as a test port. The model call is a seam (`writeNotice`), so the
 * alert path is tested against literal writer answers — the same precedent as the scripted
 * `classify` port — while the writer's own words are judged by the cached eval
 * (`apps/worker/evals/run-email-alert-notice-eval.mjs`). Records every facts object it was
 * handed so a test can assert on what the model would have been told.
 */
export interface ScriptedNoticeWriter {
  familyChildren: () => Promise<readonly FamilyChildRef[]>;
  writeNotice: (facts: EmailAlertNoticeFacts, familyId: string) => Promise<EmailAlertNotice>;
  seen: EmailAlertNoticeFacts[];
}

export function scriptedNoticeWriter(
  options: {
    children?: readonly FamilyChildRef[];
    answer?: EmailAlertNotice | ((facts: EmailAlertNoticeFacts) => EmailAlertNotice);
  } = {},
): ScriptedNoticeWriter {
  const seen: EmailAlertNoticeFacts[] = [];
  const children = options.children ?? [];
  return {
    seen,
    familyChildren: async () => children,
    writeNotice: async (facts) => {
      seen.push(facts);
      const answer = options.answer;
      if (typeof answer === 'function') return answer(facts);
      if (answer !== undefined) return answer;
      return { send: true, text: scriptedText(facts) };
    },
  };
}

/** A stand-in written text: names the occasion and asks only when there is an offer row. */
export function scriptedText(facts: EmailAlertNoticeFacts): string {
  const ask = facts.offer === null ? '' : ' Want me to add it?';
  return `Heads up about ${facts.email.title}.${ask}`;
}
