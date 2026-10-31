import type { AgentClient } from '@hale/agent';
import { pickLane } from '@hale/agent';
import { z } from 'zod';
import { CHANNEL_SIGNIN_TTL_MS } from '~/lib/auth/channel-signin';
import { connectorNoun } from '~/lib/channel/connect/copy';
import { GOOGLE_UNVERIFIED_APP_FACT } from '~/lib/channel/connect/text-connect';
import { type ReplyLanguage, certainLanguageHint } from '~/lib/channel/language';
import { loadCronSkill } from '~/lib/cron/skill';
import type { ConnectorProvider } from '~/lib/integrations/google-oauth';
import { forceToolJson } from '~/lib/pipeline/structured';

/**
 * #868 · the lines that used to be fixed, written by the model each time.
 *
 * Barton's rule: no fixed copy, no required or banned phrases. The facts a parent
 * must act on (a link, a phone number, an address) are DATA, handed in as
 * `mustInclude` and checked back verbatim; every word around them is the model's.
 * A failed or unusable write returns null and the caller pages #ops — nothing
 * canned goes out in its place.
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
  /** VIL-505: the line riding Hale's contact card (vCard MMS) at intake. */
  | 'contact_card';

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
  /** Plain values, or a small structured fact (a list, or named parts) the model words itself. */
  facts: Record<string, SaidLineFact>;
  /** Strings that must appear verbatim (numbers, addresses). Never a URL: see links. */
  mustInclude?: readonly string[];
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

/** The user-turn payload. Shared with the evals, which replay this request shape. */
export function saidLineUserMessage(input: SaidLineInput): string {
  return JSON.stringify({
    purpose: input.purpose,
    // A hint only when certain; the parent's words decide the reply's language (#868).
    languageHint: certainLanguageHint(input.language),
    parentWords: input.parentWords ?? null,
    facts: input.facts,
    mustInclude: input.mustInclude ?? [],
    linkSlots: Object.keys(input.links ?? {}).map(linkSlot),
  });
}

/**
 * Structural checks only: non-empty, every required fact verbatim, each link slot
 * exactly once, and no URL typed by the model at all. Then code fills the slots
 * with the exact URLs, so a link can never be mistyped (#868).
 */
export function acceptSaidLine(text: string, input: SaidLineInput): string | null {
  let body = text.trim();
  if (body.length === 0) return null;
  const required = input.mustInclude ?? [];
  if (!required.every((fact) => body.includes(fact))) return null;
  if (/https?:\/\//i.test(body) || /\bwww\./i.test(body)) return null;
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

export type CrisisKind = 'emergency' | 'mental';

/**
 * A crisis was flagged and no reply goes out (#868: there is no fixed crisis line to
 * fall back on, anywhere). Never silent: an urgent, body-free log for #ops (rule #1).
 */
export function logCrisisUnanswered(kind: CrisisKind, where: string): void {
  console.error(
    { urgent: true, kind, where },
    'URGENT: crisis flagged, no reply sent - page #ops now',
  );
}

/**
 * The crisis reply in the model's words; the numbers are the checked facts. Null after
 * the urgent log when nothing could be written: the caller sends nothing.
 */
export async function writeCrisisLine(
  writer: SaidLineWriter | null | undefined,
  kind: CrisisKind,
  parentWords: string,
  where: string,
): Promise<string | null> {
  const written = writer
    ? await writer.write({
        purpose: kind === 'emergency' ? 'crisis_emergency' : 'crisis_mental',
        language: null,
        parentWords,
        facts:
          kind === 'emergency'
            ? { emergency: '911' }
            : { crisisLine: '988 (call or text, Canada and US)', emergency: '911' },
        mustInclude: kind === 'emergency' ? ['911'] : ['988'],
      })
    : null;
  if (!written) logCrisisUnanswered(kind, where);
  return written;
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
