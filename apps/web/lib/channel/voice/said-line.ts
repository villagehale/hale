import { randomUUID } from 'node:crypto';
import type { AgentClient } from '@hale/agent';
import { pickLane } from '@hale/agent';
import { z } from 'zod';
import { CHANNEL_SIGNIN_TTL_MS } from '~/lib/auth/channel-signin';
import { connectorNoun } from '~/lib/channel/connect/copy';
import { GOOGLE_UNVERIFIED_APP_FACT } from '~/lib/channel/connect/text-connect';
import {
  type CrisisRegion,
  type CrisisSituation,
  type CrisisWho,
  crisisFactsForRegion,
} from '~/lib/channel/crisis-resources';
import { type ReplyLanguage, certainLanguageHint } from '~/lib/channel/language';
import type { MomentUnwrittenReason } from '~/lib/channel/off-domain/moment-reply';
import { loadCronSkill } from '~/lib/cron/skill';
import { hasLinkShape } from '~/lib/format/link-shape';
import type { ConnectorProvider } from '~/lib/integrations/google-oauth';
import { forceToolJson } from '~/lib/pipeline/structured';
import {
  type CrisisKind,
  type CrisisViolation,
  crisisReplyViolation,
  replyLocale,
} from './crisis-check';
import { repairMisdecodedUtf8 } from './misdecoded-utf8';
import { type ConveyFact, judgeSaidLineConvey } from './said-line-convey';

export {
  type CrisisKind,
  type CrisisViolation,
  crisisMustInclude,
  crisisReplyViolation,
  readerConfirmationViolation,
} from './crisis-check';

/**
 * #868 · the lines that used to be fixed, written by the model each time.
 *
 * Barton's rule: no fixed copy, no required or banned phrases. The facts a parent
 * must act on (a link, a phone number, an address) are DATA, handed in as
 * `mustInclude` and checked back verbatim; every word around them is the model's.
 * A failed or unusable write returns null and the caller sends nothing — nothing
 * canned goes out in its place. A crisis with no reply pages #ops through
 * {@link CrisisPager}.
 */

export type SaidLinePurpose =
  | 'crisis_emergency'
  | 'crisis_mental'
  | 'identity'
  | 'connector_links'
  /** One connect link for the one Google service they asked for. */
  | 'connector_link'
  /** A co-parent in the family group chat, offered their own Google connect link. */
  | 'group_connect_ask'
  /** They asked for a date the official page has not posted. */
  | 'not_posted'
  /** They asked for a current fact search could not ground. */
  | 'no_source'
  /** A caregiver venting: warm, not a clinician, no method, no diagnosis. */
  | 'cheer_up'
  /** Someone is hurt or ill (not a crisis): Health811 and 911, never advice. */
  | 'health'
  /** A parent said yes to one village introduction. */
  | 'intro_yes'
  /** Any other answer about introductions, or the soft close (VIL-450). `facts.situation`
   * says what is true; the model words it. */
  | 'intro_reply'
  /** VIL-505: the line riding Hale's contact card (vCard MMS) at intake. */
  | 'contact_card'
  /** VIL-156: the reply to a texted Google disconnect, from what Google confirmed. */
  | 'connector_revoke';

export type SaidLineFact =
  | string
  | number
  | null
  | readonly string[]
  | { readonly [part: string]: string | readonly string[] };

export interface SaidLineInput {
  purpose: SaidLinePurpose;
  language: ReplyLanguage | null;
  /** The parent's own words, when the line answers a text. */
  parentWords?: string | null;
  /**
   * The parent's latest texts, oldest first, when the line answers none of them (a
   * proactive line such as the intro soft close). Read for the reply's LANGUAGE only;
   * the model never quotes or answers them. The language is inferred, never defaulted.
   */
  recentParentWords?: readonly string[] | null;
  /** Plain values, or a small structured fact (a list, or named parts) the model words itself. */
  facts: Record<string, SaidLineFact>;
  /** Strings that must appear verbatim (numbers, addresses). Never a URL: see links. */
  mustInclude?: readonly string[];
  /**
   * Fact KEYS whose meaning the text must carry, in the model's own words and language.
   * The key must name a fact (structural, in {@link acceptSaidLine}). Whether the
   * text carries that meaning is a judge, not a word list (VIL-530). A miss, or a
   * judge that does not run, sends nothing. The draft is never rewritten.
   */
  mustConvey?: readonly string[];
  /**
   * Links by slot name. The model never sees or types a URL (#868): it writes the
   * placeholder `[[name]]` where each link goes, and code puts the exact URL in.
   */
  links?: Readonly<Record<string, string>>;
}

/** The placeholder the model writes for a link slot. */
export function linkSlot(name: string): string {
  return `[[${name}]]`;
}

export interface SaidLineWriter {
  write(input: SaidLineInput): Promise<string | null>;
}

/** Worst-case output for one line. Crisis and identity are two or three sentences;
 * connector links carry ~140 characters of URL. */
export const SAID_LINE_MAX_TOKENS = 500;

const outputSchema = z.object({ text: z.string() });
const outputJsonSchema = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
} as const;

/** The writer's tool schema, imported by the crisis-reply eval. */
export const SAID_LINE_TOOL_SCHEMA = outputJsonSchema;

/** The user-turn payload. Shared with the evals, which replay this request shape. */
export function saidLineUserMessage(input: SaidLineInput): string {
  return JSON.stringify({
    purpose: input.purpose,
    // A hint only when certain; the parent's words decide the reply's language (#868).
    languageHint: certainLanguageHint(input.language),
    parentWords: input.parentWords ?? null,
    // Sent only when present, so every existing line's payload (and its cached evals)
    // is byte-for-byte unchanged.
    ...(input.recentParentWords && input.recentParentWords.length > 0
      ? { recentParentWords: input.recentParentWords }
      : {}),
    facts: input.facts,
    mustInclude: input.mustInclude ?? [],
    // Sent only when present, so every other line's payload (and cache key) is unchanged.
    ...(input.mustConvey && input.mustConvey.length > 0 ? { mustConvey: input.mustConvey } : {}),
    linkSlots: Object.keys(input.links ?? {}).map(linkSlot),
  });
}

/**
 * Structural checks only: non-empty, every required fact verbatim, each link slot
 * exactly once, and no URL typed by the model at all. Then code fills the slots
 * with the exact URLs, so a link can never be mistyped (#868). A write that came back
 * as its UTF-8 read through a single-byte code page is put back first (VIL-608).
 */
export function acceptSaidLine(text: string, input: SaidLineInput): string | null {
  let body = repairMisdecodedUtf8(text.trim());
  if (body.length === 0) return null;
  const required = input.mustInclude ?? [];
  if (!required.every((fact) => body.includes(fact))) return null;
  // A mustConvey key with no fact behind it is a wiring bug, not something to say.
  // The meaning itself is not matched here. The writer asks the convey judge.
  if (!(input.mustConvey ?? []).every((key) => key in input.facts)) return null;
  // A required fact is code's own text (Hale's site, its email), so only the rest is read.
  const prose = required.reduce((rest, fact) => rest.split(fact).join(' '), body);
  if (hasLinkShape(prose)) return null;
  for (const [name, url] of Object.entries(input.links ?? {})) {
    const slot = linkSlot(name);
    if (body.split(slot).length !== 2) return null;
    body = body.replace(slot, url);
  }
  if (/\[\[[^\]]*\]\]/.test(body)) return null;
  return body;
}

export function createSaidLineWriter(
  clientOrResolver: AgentClient | (() => AgentClient),
): SaidLineWriter {
  return {
    async write(input) {
      try {
        const client =
          typeof clientOrResolver === 'function' ? clientOrResolver() : clientOrResolver;
        const skill = await loadCronSkill('said-line');
        const { value } = await forceToolJson({
          client,
          lane: pickLane(skill.meta.task),
          system: skill.instructions,
          userMessage: saidLineUserMessage(input),
          toolName: 'said_line',
          toolDescription: 'Return the one text Hale sends.',
          inputJsonSchema: outputJsonSchema,
          schema: outputSchema,
          maxTokens: SAID_LINE_MAX_TOKENS,
        });
        const accepted = acceptSaidLine(value.text, input);
        if (accepted === null) {
          console.error({ purpose: input.purpose }, 'said line: unusable write - nothing sent');
          return null;
        }
        // VIL-530 (Sloane): when meanings are required, a judge reads the outbound
        // text. A miss or a judge that does not run sends nothing. The text that
        // passed is returned as written, or not at all. It is never rewritten.
        const required = conveyFacts(input);
        if (required === null) {
          console.error(
            { purpose: input.purpose },
            'said line: mustConvey fact missing - nothing sent',
          );
          return null;
        }
        if (required.length === 0) return accepted;
        const gate = await judgeSaidLineConvey(() => client, accepted, required);
        if (gate.verdict !== 'send') {
          console.error(
            {
              purpose: input.purpose,
              reason: gate.verdict === 'omit' ? 'must_convey' : gate.reason,
            },
            'said line: required meaning not conveyed - nothing sent',
          );
          return null;
        }
        return accepted;
      } catch (err) {
        console.error(
          { purpose: input.purpose, err: err instanceof Error ? err.name : 'unknown' },
          'said line: write failed - nothing sent',
        );
        return null;
      }
    },
  };
}

/**
 * One text carrying one connect link, in the model's words (#868: the fixed
 * single-provider offer is gone). The link is the required fact; the unverified-app
 * caution rides as a fact the model must convey. Null: the caller sends nothing.
 */
export async function writeConnectorLink(
  writer: SaidLineWriter | null | undefined,
  input: { language: ReplyLanguage | null; provider: ConnectorProvider; url: string },
): Promise<string | null> {
  if (!writer) {
    console.error('connector link: no line writer - nothing sent');
    return null;
  }
  const service = await connectorNoun(input.language, input.provider);
  if (!service) return null;
  return writer.write({
    purpose: 'connector_link',
    language: input.language,
    facts: {
      service,
      link: linkSlot('link'),
      minutesValid: LINK_MINUTES,
      googleCaution: GOOGLE_UNVERIFIED_APP_FACT,
    },
    links: { link: input.url },
  });
}

/**
 * The group chat's connect ask, in the model's words: who it is for, what connecting
 * does, that the link is theirs alone and optional, and the unverified-app caution as
 * a fact. Code puts the URL in the slot. Null: the caller sends nothing.
 */
export async function writeGroupConnectAsk(
  writer: SaidLineWriter | null | undefined,
  input: { language: ReplyLanguage | null; provider: 'gcal' | 'gmail'; name: string; url: string },
): Promise<string | null> {
  if (!writer) {
    console.error('group connect ask: no line writer - nothing sent');
    return null;
  }
  const gmail = input.provider === 'gmail';
  const service = await connectorNoun(input.language, input.provider);
  if (!service) return null;
  return writer.write({
    purpose: 'group_connect_ask',
    language: input.language,
    facts: {
      name: input.name,
      service,
      why: gmail
        ? 'Hale would catch school and camp emails for them too'
        : "their calendar joins the kids' year Hale keeps for the family",
      linkIsTheirs: 'the link is only for this parent, not the rest of the group',
      minutesValid: LINK_MINUTES,
      inboxPrivate: gmail ? 'nothing from their inbox is shown in the group chat' : null,
      link: linkSlot('link'),
      googleCaution: GOOGLE_UNVERIFIED_APP_FACT,
    },
    links: { link: input.url },
  });
}

/** Why the last draft was not sent, handed back to the writer as a fact on its one re-ask. */
export const CRISIS_VIOLATION_FACT: Readonly<Record<CrisisViolation | 'write_failed', string>> = {
  write_failed: 'the last draft could not be used, so it was not sent',
  missing_line: 'the last draft did not carry the line in facts, so it was not sent',
  emergency_988: 'the last draft carried 988, and an emergency reply carries 911 only',
  other_number: 'the last draft carried a number that is not in facts, so it was not sent',
  link: 'the last draft carried a link or web address, so it was not sent',
  wrong_script: 'the last draft was not written in the reply language, so it was not sent',
};

/** The person in danger, from the reader's closed `who`. "Someone" read as a stranger (zh, 11-03). */
const EMERGENCY_WHO_PHRASES: Readonly<Record<CrisisWho, string>> = {
  child: 'their child',
  adult: 'an adult who is with them',
  self: 'the parent who is texting',
  unknown: 'a person (Hale was not told who)',
};

const EMERGENCY_WHAT_PHRASES: Readonly<Record<CrisisSituation, (person: string) => string>> = {
  not_breathing: (person) => `${person} is not breathing or is struggling to breathe`,
  choking: (person) => `${person} is choking`,
  poisoning_or_overdose: (person) =>
    `${person} may have swallowed something harmful or taken too much of a medicine or drug`,
  injury_or_bleeding: (person) => `${person} is injured or bleeding`,
  unresponsive: (person) => `${person} is not responding or cannot be woken`,
  fire: (person) => `there is a fire and ${person} may be in danger`,
  violence_or_threat: (person) => `${person} is being hurt or threatened by another person`,
  self_harm: (person) => `${person} has hurt themselves and may be in danger`,
  other: (person) => `${person} is hurt or in danger`,
};

/**
 * What the reader read happening on an emergency, and to whom, as a fact. The writer
 * never sees the parent's words, so without it the reply is a generic "call 911". Built
 * from two closed values only: no digits, no link, nothing from the parent's text.
 */
export function emergencySituationFact(situation: CrisisSituation, who: CrisisWho): string {
  return `they just told Hale ${EMERGENCY_WHAT_PHRASES[situation](EMERGENCY_WHO_PHRASES[who])}, right now`;
}

/**
 * The first thing to do, one per closed situation, as a fact the writer words. The 911
 * dispatcher leads: no medical instruction of Hale's own.
 */
// crisis-resources is the one source of the emergency number.
const EMERGENCY_LINE = crisisFactsForRegion(null, 'emergency').emergency;

export const EMERGENCY_FIRST_STEP_FACTS: Readonly<Record<CrisisSituation, string>> = {
  not_breathing: `call ${EMERGENCY_LINE} now and stay on the line; the ${EMERGENCY_LINE} dispatcher will tell them exactly what to do, including CPR if needed`,
  choking: `call ${EMERGENCY_LINE} now and stay on the line; the ${EMERGENCY_LINE} dispatcher will tell them exactly what to do`,
  poisoning_or_overdose: `call ${EMERGENCY_LINE} now and stay on the line; the ${EMERGENCY_LINE} dispatcher will tell them exactly what to do`,
  injury_or_bleeding: `call ${EMERGENCY_LINE} now and stay on the line; the ${EMERGENCY_LINE} dispatcher will tell them exactly what to do until help arrives`,
  unresponsive: `call ${EMERGENCY_LINE} now and stay on the line; the ${EMERGENCY_LINE} dispatcher will tell them exactly what to do, including CPR if needed`,
  fire: `get out and away from the fire first, then call ${EMERGENCY_LINE} and stay on the line with the ${EMERGENCY_LINE} dispatcher`,
  violence_or_threat: `get to a safe place if they can and call ${EMERGENCY_LINE}; the ${EMERGENCY_LINE} dispatcher will tell them what to do`,
  self_harm: `call ${EMERGENCY_LINE} now and stay on the line; the ${EMERGENCY_LINE} dispatcher will tell them exactly what to do until help arrives`,
  other: `call ${EMERGENCY_LINE} now and stay on the line; the ${EMERGENCY_LINE} dispatcher will tell them exactly what to do until help arrives`,
};

/**
 * The reply language's name in its own language ('العربية' for ar). With only the tag,
 * the writer returned mojibake for Arabic (6 of 6 draws, 11-03); the name puts the
 * script in front of it.
 */
function replyLanguageName(language: ReplyLanguage | null): string | null {
  const locale = replyLocale(language);
  if (!locale) return null;
  const name = new Intl.DisplayNames([locale.baseName], { type: 'language', fallback: 'none' }).of(
    locale.baseName,
  );
  return name ?? null;
}

/**
 * The crisis request: facts only. The parent's words never reach the writer, so an
 * injected or invented number has no source; the reply language comes from what Hale
 * already knows or the reader's language tag.
 */
export function crisisLineInput(
  kind: CrisisKind,
  region: CrisisRegion | null,
  language: ReplyLanguage | null,
  situation: CrisisSituation | null,
  who: CrisisWho | null,
  rejected?: CrisisViolation | 'write_failed',
): SaidLineInput {
  const languageName = replyLanguageName(language);
  const read = situation ?? 'other';
  return {
    purpose: kind === 'emergency' ? 'crisis_emergency' : 'crisis_mental',
    language,
    facts: {
      ...crisisFactsForRegion(region, kind),
      // A mental-health reply's facts are its lines; what happened, and to whom, changes
      // only what an emergency reply says first. Nothing read is the generic emergency.
      ...(kind === 'emergency'
        ? {
            situation: emergencySituationFact(read, who ?? 'unknown'),
            firstStep: EMERGENCY_FIRST_STEP_FACTS[read],
          }
        : {}),
      ...(languageName ? { replyLanguage: languageName } : {}),
      ...(rejected ? { previousTextNotSent: CRISIS_VIOLATION_FACT[rejected] } : {}),
    },
  };
}

/** The crisis reply's language: the one Hale already holds wins, else the one the reader read. */
export function crisisReplyLanguage(
  known: ReplyLanguage | null,
  reading: { language?: ReplyLanguage | null } | null,
): ReplyLanguage | null {
  return known ?? reading?.language ?? null;
}

/** What became of the #ops page for a crisis that got no reply. A page that did not
 * leave is its own outcome, never folded into `paged` (rule #11). */
export type CrisisPageOutcome = 'paged' | 'already_paged' | 'page_failed' | 'page_not_configured';

type CrisisUnansweredReason =
  | 'no_writer'
  | 'write_failed'
  | CrisisViolation
  /** A crisis read late (opt-out-recovery.ts): nobody can be texted on the number now. */
  | 'not_sendable'
  /** A crisis read late: the number changed hands since the text, so nobody is told. */
  | 'holder_changed'
  /** A crisis read late: the reply was written, and the send threw. */
  | 'send_failed';

/**
 * A crisis flagged with no reply sent. The page itself carries kind, where, reason and
 * writes only; the inbound and family ids are for the claim and the audit row. Never a
 * draft, the parent's words, a phone or a name (rule #1).
 */
export interface CrisisUnanswered {
  kind: CrisisKind;
  where: string;
  /** A crisis reply's reason, or the off-domain moment reply's (router/route.ts). */
  reason: CrisisUnansweredReason | MomentUnwrittenReason;
  /** Writes attempted before giving up: none with no writer or nobody to reply to, else
   * the draft and its re-ask (one when the first draft was sent and the send threw). */
  writes: 0 | 1 | 2;
  /** The provider's id for the inbound: one page per inbound, however often it is redelivered. */
  inboundId: string;
  /** The household, once provisioned; null before there is one. */
  familyId: string | null;
  /** The parent who texted, when known. The audit row names them, so a flag about one
   * adult is never read as the household's. */
  parentUserId: string | null;
  /** The language the crisis was read in, kept with the claim so a later reply needs no
   * second read of the text. Never on the page. */
  language?: ReplyLanguage | null;
  /** What the reader read happening and who is in danger, from their closed lists, kept with
   * the claim for the same reason. Never on the page. */
  situation?: CrisisSituation | null;
  who?: CrisisWho | null;
}

/** Pages #ops at once (monitoring/failure-page.ts). Required: a crisis with no reply
 * always reaches a human. */
export interface CrisisPager {
  /** The body-free record the sweep re-pages from, written before the page is tried. */
  record(alert: CrisisUnanswered): Promise<void>;
  page(alert: CrisisUnanswered): Promise<CrisisPageOutcome>;
}

export type CrisisReplyOutcome =
  | { status: 'sent'; body: string; attempts: 1 | 2 }
  | { status: 'unanswered'; reason: CrisisUnansweredReason; page: CrisisPageOutcome };

/**
 * Every crisis reply: the said-line writer, from facts only, through
 * {@link crisisReplyViolation}. A failed check, or a write that returned nothing (the
 * said-line structural check refused it, or the call failed), is re-asked once with the
 * reason named as a fact. A second failure, or no writer, pages #ops through `pager` and
 * sends nothing (#868: there is no fixed crisis line).
 */
export async function deliverCrisisReply(input: {
  kind: CrisisKind;
  language: ReplyLanguage | null;
  region: CrisisRegion | null;
  /** What the reader read happening; null when no crisis reading named one. */
  situation: CrisisSituation | null;
  /** Who the reader read is in danger; null when no crisis reading named one. */
  who: CrisisWho | null;
  where: string;
  inboundId: string;
  familyId: string | null;
  parentUserId: string | null;
  pager: CrisisPager;
  writer: SaidLineWriter | null | undefined;
}): Promise<CrisisReplyOutcome> {
  const { kind, region, language, situation, who, where, pager, writer } = input;
  const { inboundId, familyId, parentUserId } = input;
  if (!writer) {
    const reason = 'no_writer';
    const page = await logCrisisUnanswered(pager, {
      kind,
      where,
      reason,
      writes: 0,
      inboundId,
      familyId,
      parentUserId,
      language,
      situation,
      who,
    });
    return { status: 'unanswered', reason, page };
  }
  const first = checkCrisisDraft(
    kind,
    await writer.write(crisisLineInput(kind, region, language, situation, who)),
    language,
  );
  if ('body' in first) return { status: 'sent', body: first.body, attempts: 1 };
  const second = checkCrisisDraft(
    kind,
    await writer.write(crisisLineInput(kind, region, language, situation, who, first.reason)),
    language,
  );
  if ('body' in second) return { status: 'sent', body: second.body, attempts: 2 };
  const page = await logCrisisUnanswered(pager, {
    kind,
    where,
    reason: second.reason,
    writes: 2,
    inboundId,
    familyId,
    parentUserId,
    language,
    situation,
    who,
  });
  return { status: 'unanswered', reason: second.reason, page };
}

function checkCrisisDraft(
  kind: CrisisKind,
  draft: string | null,
  language: ReplyLanguage | null,
): { body: string } | { reason: CrisisViolation | 'write_failed' } {
  if (draft === null) return { reason: 'write_failed' };
  const reason = crisisReplyViolation(kind, draft, language);
  return reason === null ? { body: draft } : { reason };
}

/**
 * A crisis was flagged and no reply goes out (#868: there is no fixed crisis line to
 * fall back on, anywhere). Never silent: the record, then the page to #ops; the pager
 * (failure-page.ts) writes the urgent, body-free log. The record comes first, so a page
 * that fails or throws still leaves the row the sweep pages from. A page that did not
 * leave is logged and named in the outcome.
 *
 * An inbound with no provider id gets one fresh opaque id here, once, so the record and
 * the page share one claim and it is never deduped against another such crisis.
 */
export async function logCrisisUnanswered(
  pager: CrisisPager,
  input: CrisisUnanswered,
): Promise<CrisisPageOutcome> {
  const { kind, where, reason } = input;
  const missing = input.inboundId.trim() === '';
  if (missing) console.error({ kind, where, reason }, 'crisis page: inbound_id_missing');
  const alert = missing ? { ...input, inboundId: `missing-${randomUUID()}` } : input;
  try {
    await pager.record(alert);
  } catch (err) {
    console.error(
      { kind, where, reason, err: err instanceof Error ? err.name : 'unknown' },
      'crisis record did not land - the page is its only trace',
    );
  }
  let page: CrisisPageOutcome;
  try {
    page = await pager.page(alert);
  } catch (err) {
    console.error('crisis page: pager threw', { err: err instanceof Error ? err.name : 'unknown' });
    page = 'page_failed';
  }
  if (page === 'page_failed' || page === 'page_not_configured') {
    console.error({ kind, where, reason, page }, 'crisis page did not go out');
  }
  return page;
}

function conveyFacts(input: SaidLineInput): ConveyFact[] | null {
  const facts: ConveyFact[] = [];
  for (const key of input.mustConvey ?? []) {
    const meaning = input.facts[key];
    if (meaning === undefined) return null;
    facts.push({ key, meaning });
  }
  return facts;
}

/** Minutes a connect link stays live, said by the model (CHANNEL_SIGNIN_TTL_MS). */
/** The texted link's real life: the sign-in token's TTL (channel-signin.ts). */
const LINK_MINUTES = CHANNEL_SIGNIN_TTL_MS / 60_000;

/**
 * One text carrying both Google connect links, in the model's words (#868: the
 * fixed connector offer is gone). The links are the required facts. Null when the
 * write failed or no writer is wired: the caller sends nothing.
 */
export async function writeConnectorLinks(
  writer: SaidLineWriter | null | undefined,
  input: { language: ReplyLanguage | null; calendarUrl: string; gmailUrl: string },
): Promise<string | null> {
  if (!writer) {
    console.error('connector links: no line writer - nothing sent');
    return null;
  }
  return writer.write({
    purpose: 'connector_links',
    language: input.language,
    facts: {
      calendarLink: linkSlot('calendarLink'),
      gmailLink: linkSlot('gmailLink'),
      minutesValid: LINK_MINUTES,
      why: 'so Hale can spot daycare and school notices',
      // Both links are Google connect links, and every Google connect link carries the
      // unverified-app caution, as a fact the writer puts in its own words (text-connect.ts).
      googleCaution: GOOGLE_UNVERIFIED_APP_FACT,
    },
    links: { calendarLink: input.calendarUrl, gmailLink: input.gmailUrl },
  });
}
