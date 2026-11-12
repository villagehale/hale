import { type RegisteredTool, type Skill, defineTool } from '@hale/agent';
import { type Database, schema } from '@hale/db';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { declinePrivilegedGroupSeat } from '~/lib/channel/linq/group-members';
import { resolveReplyClient } from '~/lib/channel/reply-copy/client';
import { signupProviderHost } from './consent';
import { authorizedSignupEnabled } from './flag';
import {
  type OfferSignupResult,
  offerSignupFromFacts,
  sessionsFromModel,
} from './offer-from-facts';
import { SIGNUP_OFFER_SOURCES, type SignupOfferWriter } from './offer-writer';
import { foldWords, quotesParent, quotesParentWords } from './parent-quote';
import { registrationPlanRunEnabled } from './plan/flag';
import { untrustedActivityLabel } from './plan/reader';
import type { PlanReplyWriter } from './plan/writer';
import {
  type SignupSupersedeReader,
  type SupersedeAsk,
  createSignupSupersedeReader,
} from './supersede-reader';
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
 *
 * The program name an ask is stored under is what later names it in the parent's words, so
 * it is never only the model's: see {@link storedActivityLabel}.
 *
 * A sender whose group seat may not authorize a sign-up creates and closes nothing. A
 * family may hold several asks at once; an earlier ask of this parent closes only when a
 * model reading of their words this turn says this one replaces it, in words of theirs that
 * name it (see `toSupersedeReading`), and an unreadable reading records nothing. One the
 * reading dropped in words that do not name it stays open beside the new ask, and the
 * result lists it (`keptOpen`).
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
  /** The day-before plan's writer. Undefined uses the reply model. */
  planWriter?: PlanReplyWriter;
  /** Reads whether this ask replaces an earlier one. Undefined uses the reply model. */
  supersedeReader?: SignupSupersedeReader;
}

const sessionSchema = z.object({
  id: z.string().min(1).max(80),
  label: z.string().min(1).max(120),
  startsAt: z.string().min(1).max(40),
  endsAt: z.string().min(1).max(40),
  full: z.boolean(),
  priceCents: z.number().int().nullable(),
});

export { quotesParent };

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

/**
 * The program name an ask is stored, and later named, by. The coach model's `activity` is
 * kept only when it is whole words the parent wrote this turn or of a page title a tool
 * handed over this turn. Otherwise the registration page's own title as that tool gave it
 * stands in, cleaned; with no such page, the ask has no name and is named by its site alone.
 */
function storedActivityLabel(input: {
  activity: string;
  parentWords: string;
  links: readonly { title: string; url: string }[];
  registrationUrl: string;
  href: string;
}): string | null {
  const activity = input.activity.replace(/\s+/g, ' ').trim();
  const sources = [input.parentWords, ...input.links.map((link) => link.title)];
  if (sources.some((source) => quotesParentWords(source, activity))) return activity;
  const page = input.links.find(
    (link) => link.url === input.href || link.url === input.registrationUrl,
  );
  return page ? untrustedActivityLabel(page.title) : null;
}

const OFFSET_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** This parent's own asks still waiting on a yes, newest first. Never a co-parent's. */
async function ownPendingAsks(
  database: Database,
  input: { familyId: string; parentUserId: string },
): Promise<SupersedeAsk[]> {
  const offers = schema.authorizedSignupOffers;
  const rows = await database
    .select({
      id: offers.id,
      activityLabel: offers.activityLabel,
      providerHost: offers.providerHost,
      sessions: offers.sessions,
    })
    .from(offers)
    .where(
      and(
        eq(offers.familyId, input.familyId),
        eq(offers.parentUserId, input.parentUserId),
        eq(offers.status, 'pending'),
      ),
    )
    .orderBy(desc(offers.createdAt));
  return rows.map((row) => ({
    offerId: row.id,
    activity: row.activityLabel,
    host: row.providerHost,
    sessionLabels: row.sessions.map((session) => session.label),
  }));
}

/** An open time the model copied with its offset. A time with no zone is not one. */
export function planOpensAtFromModel(raw: string | null): Date | null {
  if (!raw || !OFFSET_TIME.test(raw)) return null;
  const at = new Date(raw);
  return Number.isNaN(at.getTime()) ? null : at;
}

export function offerSignupTool(ports: SignupOfferToolPorts): RegisteredTool {
  return defineTool({
    name: OFFER_SIGNUP_TOOL,
    description:
      "Call when Hale saw a real registration — from an email, a calendar, a flyer, or this chat — and you are offering to try signing a child up. `child` is the child's first name as this family knows them. `activity` is the program's name as the page or the parent gives it. `registrationUrl` must be a page already in this turn (the parent's words, or a link a tool returned). `evidence` is what Hale saw; for chat it must be a quote from the parent's message. `opensAt` is when registration opens, as an ISO 8601 time with its UTC offset, only when the page or message states it; otherwise null. A family can have several sign-up asks open at once: `replaced` lists any earlier ask of this parent that their words this turn dropped for this one, and is empty when every earlier ask stays open. After `recorded`, send the returned `text` as your message. Do not invent a different offer.",
    inputSchema: z.object({
      child: z.string().min(1).max(80),
      activity: z.string().min(1).max(120),
      source: z.enum(SIGNUP_OFFER_SOURCES),
      registrationUrl: z.string().min(1).max(2048),
      evidence: z.string().min(1).max(1600),
      sessions: z.array(sessionSchema).min(1).max(12),
      approvedPriceCents: z.number().int().nullable(),
      opensAt: z.string().max(40).nullable().optional(),
    }),
    monetary: false,
    touchesChildContent: false,
    handler: async (input, ctx) => {
      if (ctx.familyId !== ports.familyId) {
        throw new Error("That family is not this turn's family.");
      }
      if (
        await declinePrivilegedGroupSeat(ports.database, {
          familyId: ports.familyId,
          userId: ports.parentUserId,
          capability: 'signup',
        })
      ) {
        return { recorded: false as const, reason: 'group_member_not_authorized' };
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

      const wanted = foldWords(input.child);
      const children = await ports.database
        .select({ id: schema.children.id, name: schema.children.name })
        .from(schema.children)
        .where(eq(schema.children.familyId, ports.familyId));
      const matches = children.filter((child) => foldWords(child.name) === wanted);
      if (matches.length !== 1 || !matches[0]) {
        return { recorded: false as const, reason: 'child_missing' };
      }

      const activityLabel = storedActivityLabel({
        activity: input.activity,
        parentWords: ports.parentWords,
        links: ports.linksThisTurn(),
        registrationUrl: input.registrationUrl,
        href,
      });
      const earlier = await ownPendingAsks(ports.database, {
        familyId: ports.familyId,
        parentUserId: ports.parentUserId,
      });
      let supersede: string[] = [];
      let keptOpen: SupersedeAsk[] = [];
      if (earlier.length > 0) {
        const reader =
          ports.supersedeReader ?? createSignupSupersedeReader(() => resolveReplyClient(undefined));
        const read = await reader.read({
          text: ports.parentWords,
          next: { activity: activityLabel, host: signupProviderHost(new URL(href).hostname) },
          earlier,
        });
        // Whether the parent dropped an earlier ask is unknown: record nothing, close nothing.
        if (read === null) {
          console.warn({ earlier: earlier.length }, 'offer_signup: supersede unread, not recorded');
          return { recorded: false as const, reason: 'supersede_unread' };
        }
        supersede = read.replaced;
        keptOpen = earlier.filter((prior) => read.unnamed.includes(prior.offerId));
        if (keptOpen.length > 0) {
          console.warn(
            { keptOpen: keptOpen.length },
            'offer_signup: an earlier ask dropped in words that do not name it stays open',
          );
        }
      }

      const result: OfferSignupResult = await offerSignupFromFacts(
        ports.database,
        {
          familyId: ports.familyId,
          parentUserId: ports.parentUserId,
          childId: matches[0].id,
          now: ports.now,
          planOpensAt: planOpensAtFromModel(input.opensAt ?? null),
          activityLabel,
          supersede,
          facts: {
            source: input.source,
            evidence: input.evidence,
            registrationUrl: href,
            sessions,
            approvedPriceCents: input.approvedPriceCents,
            language: null,
          },
        },
        { writer: ports.writer, planWriter: ports.planWriter },
      );
      if (!result.ok) return { recorded: false as const, reason: result.reason };
      return {
        recorded: true as const,
        offerId: result.offerId,
        text: result.text,
        replaced: result.replaced.map((prior) => ({
          activity: prior.activityLabel,
          host: prior.providerHost,
          sessions: prior.sessionLabels,
        })),
        // Only when one was: an empty list beside `replaced` gives the coach nothing to say.
        ...(keptOpen.length > 0
          ? {
              keptOpen: keptOpen.map((prior) => ({
                activity: prior.activity,
                host: prior.host,
                sessions: prior.sessionLabels,
              })),
            }
          : {}),
      };
    },
  });
}

/**
 * Lists the verb while the signup flag is on. `atOpen` is the coach-signup-offer addendum,
 * handed in only while the plan lane is lit ({@link signupAtOpenEnabled}): it is what tells
 * the coach the capability table's no to enrolling is not the whole truth for this family.
 */
export function augmentCoachSkillForSignupOffer(
  skill: Skill,
  enabled: boolean,
  atOpen: Skill | null,
): Skill {
  if (!enabled) return skill;
  const listed = skill.meta.tools.includes(OFFER_SIGNUP_TOOL);
  if (listed && !atOpen) return skill;
  return {
    ...skill,
    meta: listed ? skill.meta : { ...skill.meta, tools: [...skill.meta.tools, OFFER_SIGNUP_TOOL] },
    instructions: atOpen ? `${skill.instructions}\n\n${atOpen.instructions}` : skill.instructions,
  };
}

export function signupOfferToolEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return authorizedSignupEnabled(env);
}

/** The plan lane: Hale can register at the open. Read from the readers the plan run reads. */
export function signupAtOpenEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return authorizedSignupEnabled(env) && registrationPlanRunEnabled(env);
}
