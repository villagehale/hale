import {
  type AgentClient,
  HAIKU_MODEL,
  type LaneConfig,
  SPARSE_CACHE_TTL,
  pickLane,
} from '@hale/agent';
import { z } from 'zod';
import { namesOptOutKeyword } from '~/lib/channel/opt-out';
import { loadCronSkill } from '~/lib/cron/skill';
import { contactsOutside } from '~/lib/format/contact-shape';
import type { OpsPager } from '~/lib/monitoring/failure-page';
import { sharedOpsPager } from '~/lib/monitoring/shared-ops-pager';
import { HOT_SMS_CLIENT_OPTIONS, budgetedAnthropic } from '~/lib/pipeline/client';
import { forceToolJson } from '~/lib/pipeline/structured';

/**
 * One parent-facing line, written by the model in whatever language the family
 * is using. There is no template behind it. The first attempt uses the skill's
 * lane. The second uses a smaller model. Both failing holds the send and pages.
 */

const MAX_TOKENS = 400;

/**
 * VIL-706 · the skills a line may carry after spoken-line's own instructions, each
 * loaded by name (CLAUDE.md rule 2) and only by a caller whose flag is lit: the join and
 * caregiver door lines, and the caregiver reminder.
 */
export const SPOKEN_LINE_ADDENDA = ['door-line', 'caregiver-reminder'] as const;
export type SpokenLineAddendum = (typeof SPOKEN_LINE_ADDENDA)[number];

export interface SpokenLineRequest {
  purpose: string;
  language: string | null;
  facts?: Readonly<Record<string, string>>;
  /** Strings that must survive unchanged: a url, a phone line, a claim phrase. */
  verbatim?: readonly string[];
  /**
   * A placeholder the line must carry exactly once, for a link the model is never handed
   * (a live join link is a capability). It reaches the model as a verbatim piece, and the
   * caller puts the link there after the line is accepted.
   */
  slot?: string;
  /**
   * A skill appended after spoken-line for this line. It rides as a system extra after
   * the cache breakpoint, and it is not part of the user message, so a line without one
   * sends exactly the bytes it sent before (its prompt cache and every recorded eval key
   * over it stand). A line with one is also refused when it names an opt-out keyword
   * ({@link acceptSpokenLine}).
   */
  addendum?: SpokenLineAddendum;
  /** Refuse a draft that names an opt-out keyword on a line with no addendum (VIL-706). */
  refuseOptOutKeyword?: boolean;
}

export interface SpokenLineWriter {
  write(request: SpokenLineRequest): Promise<string | null>;
}

const outputSchema = z.object({ text: z.string() });

const outputJsonSchema = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
} as const;

/**
 * A line is sent only when it is not empty, carries every verbatim piece, and holds no
 * link, phone number or email address beyond the ones those pieces carry (VIL-633). The
 * facts can be a third party's words (a calendar title), so a contact in a fact is not
 * grounds to say it: a caller that needs one said hands it as verbatim.
 *
 * `refuseOptOutKeyword` (VIL-706) is set for a line that carries an addendum, or asks for
 * it. Such a line is also refused when it names STOP, HELP, ARRET or AIDE as a keyword, or
 * writes an opt-out line ({@link namesOptOutKeyword}); the verbatim pieces are read as
 * facts there, so a place called "BUS STOP 14" still goes out. Other lines keep the
 * acceptance they had. `slot` must appear exactly once, with no other `[[…]]` beside it
 * and nothing glued to it, because a word on the link's end would change the link.
 */
export function acceptSpokenLine(
  text: string,
  verbatim: readonly string[] | undefined,
  options: { refuseOptOutKeyword?: boolean; slot?: string } = {},
): string | null {
  const body = text.trim();
  if (body.length === 0) return null;
  if (verbatim?.some((piece) => piece.length > 0 && !body.includes(piece))) return null;
  if (options.slot !== undefined && !carriesSlotOnce(body, options.slot)) return null;
  if (contactsOutside(body, verbatim ?? []).length > 0) return null;
  if (options.refuseOptOutKeyword && namesOptOutKeyword(body, verbatim ?? []) !== null) {
    return null;
  }
  return body;
}

/** What may touch a filled link on each side and leave it whole when a phone reads it. */
const WORD_BEFORE_LINK = /[\p{L}\p{N}]$/u;
const CLEAR_AFTER_LINK = /^(?:$|\s|[.,!?)"'\u00bb\u201d\u2019]+(?:\s|$))/u;

function carriesSlotOnce(body: string, slot: string): boolean {
  const around = body.split(slot);
  if (around.length !== 2 || /\[\[|\]\]/.test(around.join(' '))) return false;
  const [before = '', after = ''] = around;
  return !WORD_BEFORE_LINK.test(before) && CLEAR_AFTER_LINK.test(after);
}

/** What the model must carry: the request's verbatim pieces and its slot. */
function requestVerbatim(request: SpokenLineRequest): readonly string[] {
  return request.slot === undefined
    ? (request.verbatim ?? [])
    : [...(request.verbatim ?? []), request.slot];
}

/** The user turn for this request. The eval replays exactly these bytes. */
export function spokenLineUserMessage(request: SpokenLineRequest): string {
  return JSON.stringify({
    purpose: request.purpose,
    language: request.language,
    facts: request.facts ?? {},
    verbatim: requestVerbatim(request),
  });
}

/** The one acceptance for a request's draft: the writer, the scripted writer and the eval. */
export function acceptSpokenRequest(text: string, request: SpokenLineRequest): string | null {
  return acceptSpokenLine(text, requestVerbatim(request), {
    refuseOptOutKeyword: request.addendum !== undefined || request.refuseOptOutKeyword === true,
    ...(request.slot === undefined ? {} : { slot: request.slot }),
  });
}

export function smallerLane(lane: LaneConfig): LaneConfig {
  if (lane.model === HAIKU_MODEL) {
    return lane.thinking === 'disabled'
      ? lane
      : { ...lane, thinking: 'disabled', effort: 'medium' };
  }
  return { model: HAIKU_MODEL, thinking: 'adaptive', effort: 'medium' };
}

export function createSpokenLineWriter(
  client: () => AgentClient,
  pager: OpsPager,
): SpokenLineWriter {
  return {
    async write(request) {
      let skill: Awaited<ReturnType<typeof loadCronSkill>>;
      let extras: string[];
      try {
        skill = await loadCronSkill('spoken-line');
        extras = request.addendum ? [(await loadCronSkill(request.addendum)).instructions] : [];
      } catch (err) {
        console.error(
          { purpose: request.purpose, err: err instanceof Error ? err.name : 'unknown' },
          'spoken line: skill load failed',
        );
        await pager.page({
          site: 'spoken_line_unwritten',
          facts: { stage: 'skill_load' },
        });
        return null;
      }
      const first = pickLane(skill.meta.task);
      const lanes = [first, smallerLane(first)];
      for (let attempt = 0; attempt < lanes.length; attempt += 1) {
        try {
          const { value } = await forceToolJson({
            client: client(),
            lane: lanes[attempt] ?? first,
            system: skill.instructions,
            ...(extras.length > 0 ? { systemExtras: extras } : {}),
            cacheTtl: SPARSE_CACHE_TTL,
            userMessage: spokenLineUserMessage(request),
            toolName: 'spoken_line',
            toolDescription: 'Write the one text Hale will send.',
            inputJsonSchema: outputJsonSchema,
            schema: outputSchema,
            maxTokens: MAX_TOKENS,
          });
          const accepted = acceptSpokenRequest(value.text, request);
          if (accepted) return accepted;
        } catch (err) {
          console.error(
            {
              attempt: attempt + 1,
              purpose: request.purpose,
              err: err instanceof Error ? err.name : 'unknown',
            },
            'spoken line: write failed',
          );
        }
      }
      // The purpose is a caller's code with no closed list, so it is logged, never paged.
      console.error({ purpose: request.purpose }, 'spoken line: no line written');
      await pager.page({
        site: 'spoken_line_unwritten',
        facts: { stage: 'after_retry' },
      });
      return null;
    },
  };
}

let shared: SpokenLineWriter | null = null;

export function sharedSpokenLineWriter(): SpokenLineWriter {
  shared ??= createSpokenLineWriter(
    () => budgetedAnthropic(HOT_SMS_CLIENT_OPTIONS, { stage: 'spoken_line' }),
    sharedOpsPager,
  );
  return shared;
}

/** Tests install a scripted writer here; null restores the real one. */
export function setSharedSpokenLineWriter(writer: SpokenLineWriter | null): void {
  shared = writer;
}

export function speak(request: SpokenLineRequest): Promise<string | null> {
  return sharedSpokenLineWriter().write(request);
}
