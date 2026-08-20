import type { Database } from '@hale/db';
import type { ApprovalStatus } from '~/lib/channel/router/approval';
import type {
  OpenQuestion,
  OpenQuestionKind,
  OpenQuestionReader,
} from '~/lib/channel/router/open-questions';
import type { ReplyResolver } from '~/lib/channel/router/resolve';
import type { DeterministicHandler, HandlerContext } from '~/lib/channel/router/route';
import { VOICE_ANSWERED_BY_TEXT, VOICE_NOTHING_PENDING, VOICE_NOTHING_TO_UNDO } from './copy';

/**
 * Voice v2 — a parent ANSWERING Hale out loud.
 *
 * A call can now settle the same questions a text can, and it settles them through the
 * same machinery: the router's own handler chain (route.ts / handlers.ts), the same
 * open-question reader, and the same natural-reply resolver. There is deliberately no
 * spoken approval grammar in this file. A second reading of "yes" would be a second set
 * of rules about consent (rule #4), and the two would disagree the first time either was
 * edited — which is the failure the natural-reply arc was built to end, not to duplicate.
 *
 * So what IS here is only the two things a call genuinely changes:
 *
 *   WHICH QUESTIONS A VOICE MAY SETTLE ({@link SPOKEN_QUESTION_KINDS}). Approvals, and
 *   nothing else for now. The exclusions are named at the constant.
 *
 *   WHAT A RECEIPT SOUNDS LIKE. Two of the approvals grammar's lines end in an app URL,
 *   which is unusable read aloud (copy.ts). Everything else is spoken exactly as texted.
 *
 * IT RUNS BEFORE THE MODEL, for the reason the router runs its handlers before the coach:
 * "yes" is consent to execute, and the only way to guarantee a model never paraphrases it
 * is for the model never to see it. On a call that also happens to be the fastest possible
 * turn — an approval is answered in one query round trip, with no model in the loop at all.
 */

/**
 * The questions a CALL may settle. Approvals only, and each exclusion is a decision:
 *
 *   INTRO OPT-IN and INTRO PROPOSAL are excluded. Both write a consent record that
 *   discloses this household to another one, and the evidence stored beside it is the
 *   parent's own words — which on a call are Twilio's transcription of them, not
 *   theirs. A cross-household disclosure is irreversible and is graded `consequential`
 *   for exactly that reason (open-questions.ts), so the surface whose record of consent
 *   is a machine's best guess is not the surface that may grant one. The caller is not
 *   stonewalled: the turn falls through to the coach, which says it will pick it up by
 *   text, and the text lane answers it in the parent's actual words.
 *
 *   PLAN OFFER is excluded because its handler answers by SENDING two or three texts and
 *   hands the router no body at all — a caller would say yes and hear silence while their
 *   phone buzzed. Wiring it needs a spoken receipt of its own, which is a product decision
 *   rather than a wiring one.
 *
 * A kind that is open but not spoken-capable is still SHOWN to the resolver (see below),
 * so a bare "yes" with an introduction pending stays ambiguous and settles nothing.
 */
export const SPOKEN_QUESTION_KINDS: ReadonlySet<OpenQuestionKind> = new Set(['approval']);

/**
 * The receipts that cannot be spoken as written, keyed by the approvals grammar's own
 * status so a renamed outcome fails to compile rather than quietly reading a link aloud.
 */
const SPOKEN_INSTEAD: Partial<Record<ApprovalStatus, string>> = {
  nothing_pending: VOICE_NOTHING_PENDING,
  nothing_to_undo: VOICE_NOTHING_TO_UNDO,
};

export interface SpokenAnswerDeps {
  database: Database;
  /** The router's own chain, unchanged and in its own order (wiring.ts defaultHandlers).
   * Only the handlers that OWN a spoken-capable kind are ever run — the mapping is the
   * handler's own `resolves`, so it cannot drift from the chain. */
  handlers: readonly DeterministicHandler[];
  questions: OpenQuestionReader;
  replyResolver: ReplyResolver;
  /**
   * The caller's active verified number. Part of the handler contract (a handler may
   * answer for itself by text), never read by the approvals handler — and non-nullable in
   * that contract, so a call that cannot resolve one settles nothing and says why
   * (rule #11) rather than passing a placeholder into the router's chain.
   */
  sendablePhone(parentUserId: string): Promise<string | null>;
  log: Pick<Console, 'info' | 'error'>;
}

export interface SpokenTurn {
  familyId: string;
  parentUserId: string;
  /** The one long-lived thread this parent's texts and calls share. */
  conversationId: string;
  /** What Twilio heard the caller say, verbatim. */
  utterance: string;
  now: Date;
}

/**
 * Either this utterance settled something, or it did not and the coach takes the turn.
 * `spoken` is what the caller hears — never null, never empty: a handler that acted and
 * said nothing is the silence rule #11 exists to forbid.
 */
export type SpokenAnswer =
  | { status: 'answered'; spoken: string; handler: string; outcome: string }
  | { status: 'not_an_answer' };

const NOT_AN_ANSWER: SpokenAnswer = { status: 'not_an_answer' };

/**
 * Did the caller just answer something Hale is holding?
 *
 * Two passes, and they are the router's two, in its order (route.ts GATE 2 then GATE 2b):
 * the free exact read first — "yes", "no", "yes two", "undo" — then, only if a question is
 * actually open, the resolver on the words they really used.
 */
export async function answerSpokenReply(
  deps: SpokenAnswerDeps,
  turn: SpokenTurn,
): Promise<SpokenAnswer> {
  const spokenHandlers = deps.handlers.filter((handler) =>
    [...(handler.resolves ?? [])].some((kind) => SPOKEN_QUESTION_KINDS.has(kind)),
  );
  if (spokenHandlers.length === 0) return NOT_AN_ANSWER;

  const phoneE164 = await deps.sendablePhone(turn.parentUserId);
  if (phoneE164 === null) {
    // An enrolled caller has one by definition — the front door resolved this call
    // through the same active channel row. Named rather than assumed away: if it ever
    // happens, the caller's yes went to the coach and somebody has to be able to see why.
    deps.log.error(
      { familyId: turn.familyId },
      'voice: no sendable channel for the caller, so nothing spoken can be settled',
    );
    return NOT_AN_ANSWER;
  }

  // Read at most once per turn, by whoever needs it first — a handler about to claim a
  // bare affirmative, or the resolver below.
  let openQuestions: Promise<OpenQuestion[]> | null = null;
  const readOpenQuestions = () => {
    openQuestions ??= deps.questions.open(deps.database, {
      familyId: turn.familyId,
      parentUserId: turn.parentUserId,
      now: turn.now,
    });
    return openQuestions;
  };

  const context: HandlerContext = {
    familyId: turn.familyId,
    parentUserId: turn.parentUserId,
    conversationId: turn.conversationId,
    body: turn.utterance,
    phoneE164,
    now: turn.now,
    resolved: null,
    openQuestions: readOpenQuestions,
  };

  // PASS 1 — the exact words, free, and the same grammar a text is read with.
  for (const handler of spokenHandlers) {
    const verdict = await handler.handle(deps.database, context);
    if (verdict.claimed) return spoken(deps, handler.name, verdict.outcome, verdict.reply);
  }

  // PASS 2 — their own words, against what Hale is actually waiting on. Costs one small
  // model call, and only when something is open to be an answer to.
  const questions = await readOpenQuestions();
  if (questions.length === 0) return NOT_AN_ANSWER;

  // EVERY open question goes to the resolver, including the kinds a call cannot settle.
  // Hiding them would make "yes" resolve to the approval a parent was not answering —
  // consent applied to the wrong question, which is the exact failure `soleOpenKind` and
  // this stage exist to prevent (open-questions.ts).
  const reading = await deps.replyResolver.read({ text: turn.utterance, questions });
  if (reading.status === 'unresolved') return NOT_AN_ANSWER;
  if (!SPOKEN_QUESTION_KINDS.has(reading.kind)) {
    deps.log.info(
      { kind: reading.kind },
      'voice: the caller answered something a call cannot settle - the coach takes the turn',
    );
    return NOT_AN_ANSWER;
  }

  const owner = spokenHandlers.find((handler) => handler.resolves?.has(reading.kind));
  if (!owner) {
    deps.log.error(
      { kind: reading.kind },
      'voice: no handler owns this spoken question kind',
    );
    return NOT_AN_ANSWER;
  }

  const verdict = await owner.handle(deps.database, {
    ...context,
    resolved: {
      kind: reading.kind,
      questionId: reading.questionId,
      polarity: reading.polarity,
      confidence: reading.confidence,
    },
  });
  // The question closed between the two reads — the co-parent answered it in the app, the
  // draft was executed. The coach takes the turn and can say something true about it.
  if (!verdict.claimed) return NOT_AN_ANSWER;
  return spoken(deps, owner.name, verdict.outcome, verdict.reply);
}

/** What the caller hears for a verdict that claimed. */
function spoken(
  deps: SpokenAnswerDeps,
  handler: string,
  outcome: string,
  reply: string | null,
): SpokenAnswer {
  const speakable = SPOKEN_INSTEAD[outcome as ApprovalStatus] ?? reply;
  if (speakable === null) {
    // A handler that answered on another channel. Unreachable while a call settles only
    // approvals, and it is a LINE rather than silence: something was acted on, and a
    // caller who hears nothing after saying yes has been told the call is broken.
    deps.log.error(
      { handler, outcome },
      'voice: a handler settled a spoken answer and left nothing to say out loud',
    );
    return { status: 'answered', spoken: VOICE_ANSWERED_BY_TEXT, handler, outcome };
  }
  return { status: 'answered', spoken: speakable, handler, outcome };
}
