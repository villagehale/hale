import type { Database } from '@hale/db';
import type { ReplyLanguage } from '~/lib/channel/language';
import { smsSegments } from '~/lib/channel/sms-segments';
import { loadCronSkill } from '~/lib/cron/skill';
import { composeVoice, firstJsonObject, voiceClient } from '~/lib/loop/voice/compose';
import { postOpsSlack } from '~/lib/monitoring/ops-slack';
import {
  asksForKeyword,
  foldOutboundLine,
  foldedGsmLine,
  inventedName,
  mentionsOtherPerson,
  namesHale,
  stockReceiptCloser,
  straySchedule,
} from './outbound-line';

/**
 * The words after an offer is answered.
 *
 * The facts are the code's: what happened, the title, and the exact rendered
 * date-time. The line is the model's, through the same voice seam the other
 * parent-facing copy uses. A line that names a different occasion, leaves the
 * date, or tells the parent which word to type is not sent. Accents are
 * folded onto GSM-7 before that check, the same way every other outbound SMS
 * is. One
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

/**
 * Whether this line may be sent for these facts.
 *
 * It has to name the occasion and the exact rendered instant — a receipt that
 * says Thursday when the row is Sunday is the bug — stay in one GSM-7 segment
 * after the outbound fold, and not instruct a keyword. The title and the date
 * are compared after that same fold, so Fête matches the Fete the facts hold.
 */
export function offerReceiptAccepts(text: string, facts: OfferReceiptFacts): boolean {
  const line = foldedGsmLine(text);
  if (!line || smsSegments(line) !== 1) return false;
  const allowed = `${facts.title} ${facts.whenLabel}`;
  const title = foldOutboundLine(facts.title).toLowerCase();
  const when = foldOutboundLine(facts.whenLabel);
  if (!title || !line.toLowerCase().includes(title)) return false;
  if (!when || !line.includes(when)) return false;
  if (asksForKeyword(line, allowed)) return false;
  if (mentionsOtherPerson(line)) return false;
  if (namesHale(line)) return false;
  if (stockReceiptCloser(line)) return false;
  if (straySchedule(line, allowed) !== null) return false;
  if (inventedName(line, allowed) !== null) return false;
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
    if (text && offerReceiptAccepts(text, facts)) return foldOutboundLine(text);
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
              "The previous line was not sent. Copy title and when exactly, in the language given. It is this parent's own week: say your week, ta semaine, or votre semaine. Never say their week, a co-parent, or l'autre parent. One segment. Do not tell them which word to type, and do not name any other day, time, amount, or person.",
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
