import type { Database } from '@hale/db';
import { smsSegments } from '~/lib/channel/sms-segments';
import { loadCronSkill } from '~/lib/cron/skill';
import { composeVoice, firstJsonObject, voiceClient } from '~/lib/loop/voice/compose';
import { postOpsSlack } from '~/lib/monitoring/ops-slack';
import type { ExtractionKind } from '~/lib/sentinel';
import {
  asksForKeyword,
  foldOutboundLine,
  foldedGsmLine,
  inventedName,
  mentionsOtherPerson,
  mentionsSender,
  namesHale,
  stockOpener,
  straySchedule,
} from './outbound-line';

/**
 * The words of an email alert.
 *
 * The facts are the code's: who wrote, the occasion, the exact rendered date, and
 * whether a question has a row behind it. The line is the model's, through the same
 * voice seam the offer receipt uses. A line that names a different occasion, a
 * different instant, or tells the parent which word to type is not sent. One retry,
 * then nothing goes to the parent and #ops is told (VIL-404). There is no canned
 * sentence waiting underneath.
 */

export type EmailAlertOfferAsk = 'week' | 'calendar';

export interface EmailAlertVoiceFacts {
  kind: ExtractionKind;
  /** Display name or domain, already folded. Null when there is nobody to name. */
  sender: string | null;
  /** The occasion, already sanitized. Null when the vendor title survived as nothing. */
  title: string | null;
  /** The title already says what happened, so a second verb would say it twice. */
  titleCarriesVerb: boolean;
  change: 'cancelled' | 'moved' | null;
  /** The exact rendered instant. The line must contain this string. */
  whenLabel: string | null;
  /** The earlier date, exact. The line must contain this string. */
  wasLabel: string | null;
  /** A short place, exact, with no leading "at". */
  place: string | null;
  /**
   * The going clause, exact, including its leading comma. Null when the count is
   * not spoken. The line must contain it verbatim — a model must not invent the
   * number or say "families" without "Hale".
   */
  going: string | null;
  /** A question is allowed only when an offer row will exist. */
  offer: EmailAlertOfferAsk | null;
  teen: boolean;
  /** The mail is the parent's own calendar: name and time, and no sender. */
  calendarNotice: boolean;
  language: 'en';
  /** Substrings the line must not contain — a teen's sender and time, a calendar's name. */
  withheld: readonly string[];
}

/** One compose attempt, then the ops page. A test hands back a line; production
 * calls the voice seam. */
export interface EmailAlertVoicePorts {
  attempt(facts: EmailAlertVoiceFacts, tryIndex: number): Promise<string | null>;
  alert(text: string): Promise<unknown>;
}

const ATTEMPTS = 2;

/** Why a line may not be sent, or null when it may. `segments` is the one reason
 * the retry may drop the going clause — the count is the first thing that goes.
 * Accents are folded before any of these checks, and the title, the date, and
 * the sender are compared after that same fold. */
export function emailAlertRejection(
  text: string | null,
  facts: EmailAlertVoiceFacts,
): string | null {
  if (!text) return 'empty';
  if (text.includes('\n') || text.includes('\r')) return 'newline';
  const line = foldedGsmLine(text);
  if (!line) return 'empty';
  if (smsSegments(line) > 2) return 'segments';
  if (asksForKeyword(line, allowedFacts(facts))) return 'keyword';
  if (facts.offer === null) {
    if (line.includes('?')) return 'question';
  } else if (!line.endsWith('?')) {
    return 'no_question';
  }
  if (mentionsOtherPerson(line)) return 'person';
  if (namesHale(withoutGoing(line, facts.going))) return 'hale';
  if (stockOpener(line)) return 'opener';
  if (facts.title && !line.toLowerCase().includes(foldOutboundLine(facts.title).toLowerCase())) {
    return 'title';
  }
  if (facts.whenLabel && !line.includes(foldOutboundLine(facts.whenLabel))) return 'when';
  if (facts.wasLabel && !line.includes(foldOutboundLine(facts.wasLabel))) return 'was';
  if (facts.sender && !mentionsSender(line, facts.sender)) return 'sender';
  if (facts.place && !line.includes(foldOutboundLine(facts.place))) return 'place';
  if (facts.going && !line.includes(facts.going)) return 'going';
  const lower = line.toLowerCase();
  for (const hidden of facts.withheld) {
    const folded = foldOutboundLine(hidden);
    if (folded.length >= 4 && lower.includes(folded.toLowerCase())) return 'withheld';
  }
  const stray = straySchedule(line, allowedFacts(facts));
  if (stray) return stray;
  if (inventedName(line, allowedFacts(facts))) return 'stray_name';
  return null;
}

function allowedFacts(facts: EmailAlertVoiceFacts): string {
  return [facts.title, facts.whenLabel, facts.wasLabel, facts.sender, facts.place, facts.going]
    .filter((slot): slot is string => slot !== null && slot !== '')
    .join(' ');
}

function withoutGoing(line: string, going: string | null): string {
  if (!going) return line;
  return line.split(going).join(' ');
}

export function emailAlertAccepts(text: string, facts: EmailAlertVoiceFacts): boolean {
  return emailAlertRejection(text, facts) === null;
}

/**
 * The line a test hands the sweep. It copies the facts and nothing else, so the
 * verifier accepts it. It is not a sentence Hale sends: production calls the model,
 * and a miss sends nothing.
 */
export function echoEmailAlertLine(facts: EmailAlertVoiceFacts): string {
  if (facts.teen) {
    return `${facts.title ?? 'Something'}. Details stay out of this text.`;
  }
  if (facts.calendarNotice) {
    const name = facts.title ?? 'Something';
    if (!facts.whenLabel) return `${name}.`;
    return facts.whenLabel.endsWith('.')
      ? `${name} on ${facts.whenLabel}`
      : `${name} on ${facts.whenLabel}.`;
  }
  const bits: string[] = [];
  if (facts.sender) bits.push(facts.sender);
  if (facts.change && !facts.titleCarriesVerb) bits.push(facts.change);
  if (facts.title) bits.push(facts.title);
  else if (!facts.change) bits.push('something');
  let line = bits.join(' ');
  if (facts.whenLabel) line += ` ${facts.whenLabel}`;
  if (facts.wasLabel) line += ` ${facts.wasLabel}`;
  if (facts.place) line += ` ${facts.place}`;
  if (facts.going) line += facts.going;
  if (!line.endsWith('.')) line += '.';
  if (facts.offer === 'week') line += ' Want this on your week?';
  if (facts.offer === 'calendar') line += ' Want this saved?';
  return line;
}

/** Two attempts. A line that does not fit may drop the going clause on the second
 * try; any other miss retries the same facts. Both misses page #ops and return
 * null. The page names the kind and why, never the line. */
export async function writeEmailAlert(
  facts: EmailAlertVoiceFacts,
  ports: EmailAlertVoicePorts,
): Promise<{ line: string; going: string | null } | null> {
  let reason = 'empty';
  let factsForTry = facts;
  for (let tryIndex = 0; tryIndex < ATTEMPTS; tryIndex += 1) {
    let text: string | null = null;
    try {
      text = await ports.attempt(factsForTry, tryIndex);
    } catch (err) {
      console.error(
        { err: err instanceof Error ? err.name : 'unknown', kind: facts.kind },
        'email alert voice: compose threw',
      );
      reason = 'threw';
      continue;
    }
    const reject = emailAlertRejection(text, factsForTry);
    if (reject === null && text) return { line: foldOutboundLine(text), going: factsForTry.going };
    reason = reject ?? 'empty';
    if (tryIndex === 0 && facts.going && reject === 'segments') {
      factsForTry = { ...facts, going: null };
    }
  }
  await ports.alert(`email alert: unsent after retry (${facts.kind}, ${reason})`);
  return null;
}

const VOICE_MAX_TOKENS = 180;

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

function factSlots(facts: EmailAlertVoiceFacts): string[] {
  return [
    facts.title,
    facts.whenLabel,
    facts.wasLabel,
    facts.sender,
    facts.place,
    facts.going,
  ].filter((slot): slot is string => slot !== null && slot !== '');
}

async function composeEmailAlertLine(
  database: Database,
  familyId: string,
  facts: EmailAlertVoiceFacts,
  tryIndex: number,
): Promise<string | null> {
  const client = voiceClient();
  if (!client) return null;
  let skill: Awaited<ReturnType<typeof loadCronSkill>>;
  try {
    skill = await loadCronSkill('email-alert-voice');
  } catch (err) {
    console.error(
      { err: err instanceof Error ? err.name : 'unknown' },
      'email alert voice: skill load failed',
    );
    return null;
  }
  const composed = await composeVoice<{ line: string }>({
    skill,
    context: {
      kind: facts.kind,
      sender: facts.sender,
      title: facts.title,
      titleCarriesVerb: facts.titleCarriesVerb,
      change: facts.change,
      when: facts.whenLabel,
      was: facts.wasLabel,
      place: facts.place,
      going: facts.going,
      offer: facts.offer,
      teen: facts.teen,
      calendarNotice: facts.calendarNotice,
      language: facts.language,
      ...(tryIndex > 0
        ? {
            refused:
              'The previous line was not sent. Copy the facts exactly. Speak as I, about your week. Do not open with Just a heads-up or Just a reminder, and do not say Hale did something. Do not name a person, amount, day, or time you were not given. Stay in two segments, and do not tell them which word to type. Leave the other-families clause out only if it was what made the line too long.',
          }
        : {}),
    },
    factSlots: factSlots(facts),
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
export function productionEmailAlertVoicePorts(
  database: Database,
  familyId: string,
): EmailAlertVoicePorts {
  return {
    attempt: (facts, tryIndex) => composeEmailAlertLine(database, familyId, facts, tryIndex),
    alert: (text) => postOpsSlack(text),
  };
}
