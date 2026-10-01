/**
 * Deterministic refusal for the chat distiller.
 *
 * The skill tells the model to save only what a parent said. This is the check
 * that still runs when the model does not. A suggestion list, a "found"
 * activity, or anything Hale proposed is not enrollment, and a summary may not
 * say the family enrolled, signed up, booked, or registered unless a live
 * activity booking or family event names that class.
 */

export interface DistillGuardTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface DistillReceipt {
  title: string;
}

export type DistillGuardDecision =
  | { action: 'keep' }
  | { action: 'drop'; reason: 'ungrounded_enrollment' | 'assistant_suggestion' }
  | { action: 'rewrite'; summary: string; reason: 'stripped_ungrounded_enrollment' };

const ENROLLMENT =
  /\b(?:enrol(?:l(?:ed|ment|ing)?|led|ment|ling)?|signed[\s_-]?up|signups?|booked|registered|registration)\b/i;

const YOUR_PICK = /\byour[\s_-]+pick\b/i;

const PHRASE = /\b[A-Z][A-Za-z0-9'’]*(?:\s+(?:&\s+)?[A-Z][A-Za-z0-9'’]*)+\b/g;

/** Tokens that show up in almost every family sentence and must not "back" a class. */
const GENERIC = new Set([
  'parent',
  'parents',
  'child',
  'children',
  'family',
  'class',
  'classes',
  'years',
  'year',
  'month',
  'months',
  'their',
  'there',
  'about',
  'based',
  'starting',
  'start',
  'activity',
  'activities',
  'program',
  'programs',
  'enrolled',
  'enrollment',
  'enrolment',
  'enrolling',
  'signed',
  'booked',
  'registered',
  'registration',
  'signup',
  'signups',
]);

function phrasesIn(text: string): string[] {
  return text.match(new RegExp(PHRASE.source, 'g')) ?? [];
}

function contentTokens(text: string): string[] {
  return (text.toLowerCase().match(/[a-z][a-z0-9]{4,}/g) ?? []).filter(
    (token) => !GENERIC.has(token),
  );
}

function receiptBacks(text: string, receipts: readonly DistillReceipt[]): boolean {
  const claim = new Set(contentTokens(text));
  return receipts.some((receipt) => contentTokens(receipt.title).some((token) => claim.has(token)));
}

function receiptCoversPhrase(phrase: string, receipts: readonly DistillReceipt[]): boolean {
  const key = phrase.toLowerCase();
  return receipts.some((receipt) => receipt.title.toLowerCase().includes(key));
}

function assistantOnlyPhrases(summary: string, turns: readonly DistillGuardTurn[]): string[] {
  const assistant = turns
    .filter((turn) => turn.role === 'assistant')
    .map((turn) => turn.content)
    .join('\n');
  const user = turns
    .filter((turn) => turn.role === 'user')
    .map((turn) => turn.content)
    .join('\n')
    .toLowerCase();
  const summaryFold = summary.toLowerCase();
  const assistantFold = assistant.toLowerCase();
  const seen = new Set<string>();
  for (const phrase of [...phrasesIn(summary), ...phrasesIn(assistant)]) {
    seen.add(phrase.toLowerCase());
  }
  return [...seen].filter(
    (phrase) =>
      summaryFold.includes(phrase) && assistantFold.includes(phrase) && !user.includes(phrase),
  );
}

function sentencesOf(summary: string): string[] {
  return summary
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

function claimsEnrollment(text: string): boolean {
  return ENROLLMENT.test(text) || YOUR_PICK.test(text);
}

/**
 * True when the handler must read the conversation and the booking tables.
 * A plain parent fact ("naps twice a day") does not, so the save path stays a
 * write.
 */
export function distillFactNeedsEvidence(factKey: string, summary: string): boolean {
  const key = factKey.replaceAll('_', ' ');
  return claimsEnrollment(`${key}\n${summary}`) || phrasesIn(summary).length > 0;
}

function keepSentence(
  sentence: string,
  assistantOnly: readonly string[],
  receipts: readonly DistillReceipt[],
): boolean {
  if (YOUR_PICK.test(sentence)) return false;
  const uncovered = assistantOnly.filter(
    (phrase) => sentence.toLowerCase().includes(phrase) && !receiptCoversPhrase(phrase, receipts),
  );
  if (uncovered.length > 0) return false;
  if (ENROLLMENT.test(sentence) && !receiptBacks(sentence, receipts)) return false;
  return true;
}

export function guardChatDistilledFact(input: {
  factKey: string;
  summary: string;
  turns: readonly DistillGuardTurn[];
  receipts: readonly DistillReceipt[];
}): DistillGuardDecision {
  const key = input.factKey.replaceAll('_', ' ');
  if (
    YOUR_PICK.test(key) ||
    (ENROLLMENT.test(key) && !receiptBacks(`${key}\n${input.summary}`, input.receipts))
  ) {
    return { action: 'drop', reason: 'ungrounded_enrollment' };
  }

  const assistantOnly = assistantOnlyPhrases(input.summary, input.turns);
  const sentences = sentencesOf(input.summary);
  const kept = sentences.filter((sentence) =>
    keepSentence(sentence, assistantOnly, input.receipts),
  );

  if (kept.length === sentences.length) return { action: 'keep' };
  if (kept.length === 0) {
    const enrollment = claimsEnrollment(`${key}\n${input.summary}`);
    return {
      action: 'drop',
      reason: enrollment ? 'ungrounded_enrollment' : 'assistant_suggestion',
    };
  }
  return {
    action: 'rewrite',
    summary: kept.join(' '),
    reason: 'stripped_ungrounded_enrollment',
  };
}
