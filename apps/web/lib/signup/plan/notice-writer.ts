import { type AgentClient, hasGarbledText, pickLane } from '@hale/agent';
import { z } from 'zod';
import { loadCronSkill } from '~/lib/cron/skill';
import { hasLinkShape } from '~/lib/format/link-shape';
import { forceToolJson } from '~/lib/pipeline/structured';
import type { LoginCardText } from '../login-link/store';
import { asBubbles } from './bubbles';
import type { PlanPrepDraft, PlanPrepFacts, PlanPrepWriter } from './prep';
import { clocksIn, moneyCentsIn, planReplyText, planReplyViolations } from './writer';

export const SIGNUP_PROVIDER_NOTICE_SKILL = 'signup-provider-notice';
export const SIGNUP_PROVIDER_NOTICE_TOOL = 'signup_provider_notice';
export const SIGNUP_PROVIDER_NOTICE_MAX_TOKENS = 800;
export const SIGNUP_PROVIDER_NOTICE_TOOL_DESCRIPTION =
  'Write the short registration bubbles the parent sees.';
/** A bound on what a preview can hold, not a style rule: the skill asks for short words. */
export const LOGIN_CARD_MAX_CHARS = 200;
export const signupProviderNoticeSchema = z
  .object({
    bubbles: z.array(z.string()).min(1).optional(),
    text: z.string().optional(),
    // Read on its own below, so a malformed card never costs the bubbles.
    card: z.unknown().optional(),
  })
  .strict()
  .refine((value) => Boolean(value.bubbles?.length || value.text?.trim()), {
    message: 'bubbles or text',
  });
const loginCardDraftSchema = z.object({ title: z.string(), description: z.string() });
export const SIGNUP_PROVIDER_NOTICE_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    bubbles: { type: 'array', items: { type: 'string' } },
    card: {
      type: 'object',
      properties: { title: { type: 'string' }, description: { type: 'string' } },
      required: ['title', 'description'],
      additionalProperties: false,
    },
  },
  required: ['bubbles'],
  additionalProperties: false,
} as const;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Why the card preview's words cannot go. Empty means they can. Whoever renders the link
 * reads the preview, so it names no child; it says only what the card facts say: no price,
 * no clock that is not in the open or the session label, and no link but the provider host
 * itself, which the page names too.
 */
export function loginCardViolations(card: LoginCardText, facts: PlanPrepFacts): string[] {
  const out: string[] = [];
  const known = facts.loginCard;
  const allowedClocks = new Set(
    [known?.opensAt?.local ?? '', known?.sessionLabel ?? ''].flatMap((blob) => clocksIn(blob)),
  );
  const host = new RegExp(escapeRegExp(facts.host), 'gi');
  const child = facts.childFirstName?.trim()
    ? new RegExp(
        `(?<![\\p{L}\\p{M}])${escapeRegExp(facts.childFirstName.trim())}(?![\\p{L}\\p{M}])`,
        'iu',
      )
    : null;
  for (const [field, text] of [
    ['title', card.title],
    ['description', card.description ?? ''],
  ] as const) {
    if (field === 'title' && !text.trim()) out.push('empty title');
    if (text.length > LOGIN_CARD_MAX_CHARS) out.push(`${field}: too long for a card preview`);
    if (hasLinkShape(text.replace(host, ' '))) out.push(`${field}: contains a link`);
    if (hasGarbledText(text)) out.push(`${field}: garbled characters`);
    if (child?.test(text)) out.push(`${field}: names the child`);
    if (moneyCentsIn(text).length > 0) out.push(`${field}: a price`);
    if (clocksIn(text).some((mins) => !allowedClocks.has(mins))) {
      out.push(`${field}: a time that is not in the card facts`);
    }
  }
  return out;
}

/** The user turn: the facts, and on the one retry why the last draft could not go. */
export function providerNoticeUserMessage(facts: PlanPrepFacts, violation: string | null): string {
  return JSON.stringify(violation === null ? { facts } : { facts, violation });
}

/**
 * The preview's words when the facts asked for a card, or null, named: the page then
 * previews the bare provider host and no fixed sentence.
 */
export function keptCard(raw: unknown, facts: PlanPrepFacts): LoginCardText | null {
  if (!facts.loginCard) return null;
  const parsed = loginCardDraftSchema.safeParse(raw);
  if (!parsed.success) {
    console.info(
      { kind: facts.kind, code: 'card_unwritten' },
      'signup notice: card shows the host',
    );
    return null;
  }
  const description = planReplyText(parsed.data.description);
  const card = { title: planReplyText(parsed.data.title), description: description || null };
  const violations = loginCardViolations(card, facts);
  if (violations.length > 0) {
    console.info(
      { kind: facts.kind, code: 'card_refused', violations },
      'signup notice: card shows the host',
    );
    return null;
  }
  return card;
}

export function createProviderNoticeWriter(
  client: () => AgentClient | null | Promise<AgentClient | null>,
): PlanPrepWriter {
  return {
    async write(facts: PlanPrepFacts): Promise<PlanPrepDraft | null> {
      let resolved: AgentClient | null;
      try {
        resolved = await client();
      } catch {
        return null;
      }
      if (!resolved) return null;
      let skill: Awaited<ReturnType<typeof loadCronSkill>>;
      try {
        skill = await loadCronSkill(SIGNUP_PROVIDER_NOTICE_SKILL);
      } catch {
        return null;
      }
      // One retry with the violation, as the plan reply writer does: a draft that still
      // cannot go sends nothing.
      let note: string | null = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const { value } = await forceToolJson({
            client: resolved,
            lane: pickLane(skill.meta.task),
            system: skill.instructions,
            userMessage: providerNoticeUserMessage(facts, note),
            toolName: SIGNUP_PROVIDER_NOTICE_TOOL,
            toolDescription: SIGNUP_PROVIDER_NOTICE_TOOL_DESCRIPTION,
            inputJsonSchema: SIGNUP_PROVIDER_NOTICE_TOOL_SCHEMA,
            schema: signupProviderNoticeSchema,
            maxTokens: SIGNUP_PROVIDER_NOTICE_MAX_TOKENS,
          });
          const bubbles = asBubbles(value.bubbles ?? value.text ?? null);
          if (!bubbles) return null;
          const sent = bubbles.map(planReplyText);
          const violations = sent.flatMap((text) => planReplyViolations(text));
          if (violations.length === 0) return { bubbles: sent, card: keptCard(value.card, facts) };
          note = violations.join('; ');
        } catch {
          return null;
        }
      }
      console.info({ kind: facts.kind, code: 'violations', note }, 'signup notice: not sent');
      return null;
    },
  };
}
