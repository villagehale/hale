import { type RegisteredTool, type Skill, defineTool } from '@hale/agent';
import { type Database, schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { authorizedSignupEnabled } from './flag';
import { type OfferSignupResult, offerSignupFromFacts, sessionsFromModel } from './offer-from-facts';
import { SIGNUP_OFFER_SOURCES, type SignupOfferWriter } from './offer-writer';
import type { SignupSession } from './types';
import { registrationUrlAllowed } from './url';

/**
 * Coach verb that records a signup offer Hale's AI just wrote from facts.
 *
 * The skill on disk does not name this tool, so the channel eval's cache keys
 * stay put while AUTHORIZED_SIGNUP_ENABLED is off. When the flag is on, the
 * name is appended the way the watch verbs are.
 *
 * The URL is never the model's: it must already appear in this turn's parent
 * words or in a page a tool handed over. Chat evidence must be a quote from
 * those words. Nothing here matches keywords.
 */

export const OFFER_SIGNUP_TOOL = 'offer_signup';

export interface SignupOfferToolPorts {
  database: Database;
  familyId: string;
  parentUserId: string;
  now: Date;
  /** The parent's message this turn, verbatim. */
  parentWords: string;
  /** Pages a search or extract put in front of the parent this turn. */
  linksThisTurn: () => readonly { title: string; url: string }[];
  writer?: SignupOfferWriter;
}

const sessionSchema = z.object({
  id: z.string().min(1).max(80),
  label: z.string().min(1).max(120),
  startsAt: z.string().min(1).max(40),
  endsAt: z.string().min(1).max(40),
  full: z.boolean(),
  priceCents: z.number().int().nullable(),
});

function fold(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

export function quotesParent(parentWords: string, quote: string): boolean {
  const q = fold(quote);
  return q.length > 0 && fold(parentWords).includes(q);
}

export function urlSeenThisTurn(
  raw: string,
  parentWords: string,
  links: readonly { url: string }[],
): string | null {
  const allowed = registrationUrlAllowed(raw);
  if (!allowed.ok) return null;
  if (parentWords.includes(allowed.href) || parentWords.includes(raw)) return allowed.href;
  if (links.some((link) => link.url === allowed.href || link.url === raw)) return allowed.href;
  return null;
}

export function offerSignupTool(ports: SignupOfferToolPorts): RegisteredTool {
  return defineTool({
    name: OFFER_SIGNUP_TOOL,
    description:
      "Call when Hale saw a real registration — from an email, a calendar, a flyer, or this chat — and you are offering to try signing a child up. `child` is the child's first name as this family knows them. `registrationUrl` must be a page already in this turn (the parent's words, or a link a tool returned). `evidence` is what Hale saw; for chat it must be a quote from the parent's message. After `recorded`, send the returned `text` as your message. Do not invent a different offer.",
    inputSchema: z.object({
      child: z.string().min(1).max(80),
      source: z.enum(SIGNUP_OFFER_SOURCES),
      registrationUrl: z.string().min(1).max(2048),
      evidence: z.string().min(1).max(1600),
      sessions: z.array(sessionSchema).min(1).max(12),
      approvedPriceCents: z.number().int().nullable(),
    }),
    monetary: false,
    touchesChildContent: false,
    handler: async (input, ctx) => {
      if (ctx.familyId !== ports.familyId) {
        throw new Error("That family is not this turn's family.");
      }
      const href = urlSeenThisTurn(input.registrationUrl, ports.parentWords, ports.linksThisTurn());
      if (!href) {
        return {
          recorded: false as const,
          reason: 'url_not_this_turn',
        };
      }
      if (input.source === 'chat' && !quotesParent(ports.parentWords, input.evidence)) {
        return { recorded: false as const, reason: 'evidence_not_this_turn' };
      }
      const sessions = sessionsFromModel(input.sessions as SignupSession[]);
      if (!sessions) return { recorded: false as const, reason: 'sessions' };

      const wanted = fold(input.child);
      const children = await ports.database
        .select({ id: schema.children.id, name: schema.children.name })
        .from(schema.children)
        .where(eq(schema.children.familyId, ports.familyId));
      const matches = children.filter((child) => fold(child.name) === wanted);
      if (matches.length !== 1 || !matches[0]) {
        return { recorded: false as const, reason: 'child_missing' };
      }

      const result: OfferSignupResult = await offerSignupFromFacts(
        ports.database,
        {
          familyId: ports.familyId,
          parentUserId: ports.parentUserId,
          childId: matches[0].id,
          now: ports.now,
          facts: {
            source: input.source,
            evidence: input.evidence,
            registrationUrl: href,
            sessions,
            approvedPriceCents: input.approvedPriceCents,
            language: null,
          },
        },
        { writer: ports.writer },
      );
      if (!result.ok) return { recorded: false as const, reason: result.reason };
      return { recorded: true as const, offerId: result.offerId, text: result.text };
    },
  });
}

export function augmentCoachSkillForSignupOffer(skill: Skill, enabled: boolean): Skill {
  if (!enabled || skill.meta.tools.includes(OFFER_SIGNUP_TOOL)) return skill;
  return {
    ...skill,
    meta: { ...skill.meta, tools: [...skill.meta.tools, OFFER_SIGNUP_TOOL] },
  };
}

export function signupOfferToolEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return authorizedSignupEnabled(env);
}
