import type { Database } from '@hale/db';
import type { ReplyLanguage } from '~/lib/channel/language';
import { smsEncoding, smsSegments } from '~/lib/channel/sms-segments';
import { loadCronSkill } from '~/lib/cron/skill';
import { composeVoice, firstJsonObject, voiceClient } from '~/lib/loop/voice/compose';
import { postOpsSlack } from '~/lib/monitoring/ops-slack';

/**
 * The words after an offer is answered.
 *
 * The facts are the code's: what happened, the title, and the exact rendered
 * date-time. The line is the model's, through the same voice seam the other
 * parent-facing copy uses. A line that names a different occasion, leaves the
 * GSM-7 alphabet, or tells the parent which word to type is not sent. One
 * retry, then nothing goes to the parent and #ops is told (VIL-404). There is
 * no canned sentence waiting underneath.
 */

export type OfferReceiptKind = 'added' | 'already_added' | 'declined';

export interface OfferReceiptFacts {
  kind: OfferReceiptKind;
  title: string;
  /** The exact rendered date-time. The line must contain this string. */
  whenLabel: string;
  language: ReplyLanguage;
}

/** One compose attempt, then the ops page. Injected so a test can hand back a
 * line without a model, the same way the email classifier takes a port. */
export interface OfferReceiptPorts {
  attempt(facts: OfferReceiptFacts, tryIndex: number): Promise<string | null>;
  alert(text: string): Promise<unknown>;
}

const ATTEMPTS = 2;

const KEYWORD_INSTRUCTION =
  /\b(reply|respond|text|send|type|reponds|réponds)\b[^.?!]{0,24}\b(yes|no|oui|non)\b|\byes to confirm\b|\bpour confirmer\b/i;

const MONTH_DAY =
  /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+\d{1,2}\b/gi;

const CLOCK = /\b\d{1,2}:\d{2}\b/g;

const WEEKDAYS = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
] as const;

/**
 * Whether this line may be sent for these facts.
 *
 * It has to name the occasion and the exact rendered instant — a receipt that
 * says Thursday when the row is Sunday is the bug — stay in one GSM-7 segment,
 * and not instruct a keyword.
 */
export function offerReceiptAccepts(text: string, facts: OfferReceiptFacts): boolean {
  const line = text.trim();
  if (!line) return false;
  if (line.includes('\n') || line.includes('\r')) return false;
  if (smsEncoding(line) !== 'gsm7' || smsSegments(line) !== 1) return false;
  if (!line.toLowerCase().includes(facts.title.trim().toLowerCase())) return false;
  if (!line.includes(facts.whenLabel)) return false;
  if (KEYWORD_INSTRUCTION.test(line)) return false;

  const allowed = `${facts.title} ${facts.whenLabel}`.toLowerCase().replace(/\./g, '');
  for (const mention of line.matchAll(MONTH_DAY)) {
    const token = mention[0].toLowerCase().replace(/\./g, '');
    if (!allowed.includes(token)) return false;
  }
  for (const clock of line.matchAll(CLOCK)) {
    if (!facts.whenLabel.includes(clock[0]) && !facts.title.includes(clock[0])) return false;
  }
  for (const day of WEEKDAYS) {
    const named = new RegExp(`\\b${day}\\b`, 'i');
    if (named.test(line) && !named.test(`${facts.title} ${facts.whenLabel}`)) return false;
  }
  return true;
}

/** Two attempts. A miss both times pages #ops and returns null — the caller
 * sends nothing. The page names the kind and why, never the line. */
export async function writeOfferReceipt(
  facts: OfferReceiptFacts,
  ports: OfferReceiptPorts,
): Promise<string | null> {
  let reason = 'empty';
  for (let tryIndex = 0; tryIndex < ATTEMPTS; tryIndex += 1) {
    let text: string | null = null;
    try {
      text = await ports.attempt(facts, tryIndex);
    } catch (err) {
      console.error(
        { err: err instanceof Error ? err.name : 'unknown', kind: facts.kind },
        'offer receipt: compose threw',
      );
      reason = 'threw';
      continue;
    }
    if (text && offerReceiptAccepts(text, facts)) return text.trim();
    reason = text ? 'rejected' : 'empty';
  }
  await ports.alert(`offer receipt: unsent after retry (${facts.kind}, ${reason})`);
  return null;
}

const VOICE_MAX_TOKENS = 120;

function parseLine(answer: string | null): { line: string } | null {
  const raw = answer ? firstJsonObject(answer) : null;
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== 'line')) return null;
  if (typeof record.line !== 'string' || record.line.trim() === '') return null;
  return { line: record.line.trim() };
}

async function composeOfferReceiptLine(
  database: Database,
  familyId: string,
  facts: OfferReceiptFacts,
  tryIndex: number,
): Promise<string | null> {
  const client = voiceClient();
  if (!client) return null;
  let skill: Awaited<ReturnType<typeof loadCronSkill>>;
  try {
    skill = await loadCronSkill('offer-receipt');
  } catch (err) {
    console.error(
      { err: err instanceof Error ? err.name : 'unknown' },
      'offer receipt: skill load failed',
    );
    return null;
  }
  const composed = await composeVoice<{ line: string }>({
    skill,
    context: {
      kind: facts.kind,
      title: facts.title,
      when: facts.whenLabel,
      language: facts.language,
      canAskToRemove: facts.kind !== 'declined',
      ...(tryIndex > 0
        ? {
            refused:
              'The previous line was not sent. Copy when exactly, name the title, one GSM-7 segment, and do not tell them which word to type.',
          }
        : {}),
    },
    factSlots: [facts.title, facts.whenLabel],
    parse: parseLine,
    voiceStrings: (voice) => [voice.line],
    client,
    database,
    familyId,
    agentName: 'reply-copy',
    traceName: 'reply-copy',
    maxTokens: VOICE_MAX_TOKENS,
  });
  return composed.voice?.line ?? null;
}

/** The production ports: the voice seam, then Slack #ops. */
export function productionOfferReceiptPorts(
  database: Database,
  familyId: string,
): OfferReceiptPorts {
  return {
    attempt: (facts, tryIndex) => composeOfferReceiptLine(database, familyId, facts, tryIndex),
    alert: (text) => postOpsSlack(text),
  };
}
