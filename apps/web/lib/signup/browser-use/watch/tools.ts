import { createHash } from 'node:crypto';
import { type RegisteredTool, type Skill, defineTool } from '@hale/agent';
import { type Database, schema } from '@hale/db';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { signupProviderHost } from '../../consent';

/**
 * The coach's watch verbs: list, add and remove a provider-page watch for THIS family.
 *
 * Nothing here judges words. The model decides whether the parent asked, or agreed to a
 * proposal, in any language; the structure decides what that decision can reach:
 *
 * - FAMILY SCOPE comes from the turn, never from the model. A tool context whose family
 *   differs from the turn's is refused.
 * - CONSENT IS A REFERENCE TO THE CONSENTING TURN. `add_watch_target` takes
 *   `parentAgreement`, the parent's own words copied from the message they just sent. It
 *   must appear in that message, and the row stores the conversation, a sha256 of the
 *   message and the quote. A proposal Hale wrote has no parent words in this turn to
 *   quote, so it cannot create a target.
 * - THE URL IS NEVER THE MODEL'S. The model passes a `sourceRef` that list_watch_targets
 *   returned; the handler resolves it from this turn's search links, the family's
 *   booking emails, or the course pages they already watch.
 */
export const LIST_WATCH_TARGETS_TOOL = 'list_watch_targets';
export const ADD_WATCH_TARGET_TOOL = 'add_watch_target';
export const REMOVE_WATCH_TARGET_TOOL = 'remove_watch_target';
export const WATCH_TOOL_NAMES = [
  LIST_WATCH_TARGETS_TOOL,
  ADD_WATCH_TARGET_TOOL,
  REMOVE_WATCH_TARGET_TOOL,
] as const;

const KINDS = ['schedule', 'openings', 'waitlist'] as const;
const MAX_URL = 2048;
const MAX_CANDIDATES = 12;

export interface WatchToolPorts {
  database: Database;
  familyId: string;
  parentUserId: string;
  conversationId: string;
  /** The parent's message this turn, verbatim. */
  parentWords: string;
  /** Pages a search tool put in front of the parent this turn: title and URL. */
  linksThisTurn: () => readonly { title: string; url: string }[];
}

interface Candidate {
  sourceRef: string;
  title: string;
  provider: string;
  url: string;
}

/** https only, no credentials, bounded; null otherwise. */
export function watchableUrl(raw: string): URL | null {
  if (raw.length > MAX_URL) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}

/** Case, width and spacing folded so a quote survives the model's re-typing. */
function fold(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

export function quotesParent(parentWords: string, quote: string): boolean {
  const q = fold(quote);
  return q.length > 0 && fold(parentWords).includes(q);
}

async function candidates(ports: WatchToolPorts): Promise<Candidate[]> {
  const out: Candidate[] = [];
  const seen = new Set<string>();
  const push = (sourceRef: string, title: string, raw: string) => {
    const url = watchableUrl(raw);
    if (!url || seen.has(url.href) || out.length >= MAX_CANDIDATES) return;
    seen.add(url.href);
    out.push({ sourceRef, title, provider: signupProviderHost(url.hostname), url: url.href });
  };
  ports.linksThisTurn().forEach((link, i) => push(`link:${i}`, link.title, link.url));
  const [bookings, spots] = await Promise.all([
    ports.database
      .select({
        id: schema.activityBookings.id,
        title: schema.activityBookings.title,
        host: schema.activityBookings.providerHost,
      })
      .from(schema.activityBookings)
      .where(eq(schema.activityBookings.familyId, ports.familyId))
      .orderBy(desc(schema.activityBookings.firstSessionAt))
      .limit(MAX_CANDIDATES),
    ports.database
      .select({
        id: schema.watchedSpots.id,
        label: schema.watchedSpots.label,
        url: schema.watchedSpots.sourceUrl,
      })
      .from(schema.watchedSpots)
      .where(
        and(
          eq(schema.watchedSpots.familyId, ports.familyId),
          isNull(schema.watchedSpots.releasedAt),
        ),
      )
      .limit(MAX_CANDIDATES),
  ]);
  for (const b of bookings)
    push(`booking:${b.id}`, b.title, `https://${signupProviderHost(b.host)}/`);
  for (const s of spots) push(`spot:${s.id}`, s.label, s.url);
  return out;
}

async function liveWatches(ports: WatchToolPorts) {
  return ports.database
    .select({
      watchId: schema.familyWatchSubscriptions.id,
      targetId: schema.familyWatchSubscriptions.targetId,
      provider: schema.providerWatchTargets.providerHost,
      kind: schema.providerWatchTargets.kind,
      since: schema.familyWatchSubscriptions.createdAt,
    })
    .from(schema.familyWatchSubscriptions)
    .innerJoin(
      schema.providerWatchTargets,
      eq(schema.providerWatchTargets.id, schema.familyWatchSubscriptions.targetId),
    )
    .where(
      and(
        eq(schema.familyWatchSubscriptions.familyId, ports.familyId),
        isNull(schema.familyWatchSubscriptions.removedAt),
      ),
    );
}

function requireScope(ports: WatchToolPorts, familyId: string): void {
  if (familyId !== ports.familyId) {
    throw new Error('This tool only acts for the family in this conversation.');
  }
}

export function providerWatchTools(ports: WatchToolPorts): RegisteredTool[] {
  const list = defineTool({
    name: LIST_WATCH_TARGETS_TOOL,
    description:
      "This family's provider-page watches, and the pages that could be watched. `watching` lists live watches (`watchId`, provider, kind). `canWatch` lists pages Hale knows for this family: this turn's search results, the providers in their booking emails, and course pages they already watch, each with a `sourceRef`. Call this before add_watch_target or remove_watch_target.",
    inputSchema: z.object({}),
    monetary: false,
    touchesChildContent: false,
    handler: async (_input, ctx) => {
      requireScope(ports, ctx.familyId);
      const [watching, canWatch] = await Promise.all([liveWatches(ports), candidates(ports)]);
      return {
        watching: watching.map((w) => ({
          watchId: w.watchId,
          provider: w.provider,
          kind: w.kind,
          since: w.since.toISOString(),
        })),
        canWatch: canWatch.map((c) => ({
          sourceRef: c.sourceRef,
          title: c.title,
          provider: c.provider,
        })),
      };
    },
  });

  const add = defineTool({
    name: ADD_WATCH_TARGET_TOOL,
    description:
      "Start Hale's regular re-check of a provider page for class schedules (`schedule`), open spots (`openings`) or a waitlist (`waitlist`). Call it only when the parent, in the message they just sent and in any language, asked for this or agreed to your proposal. If you are proposing it yourself, ask first and wait for their answer; do not call this in the same turn as the proposal. `sourceRef` must come from list_watch_targets. `parentAgreement` is the parent's own words from their latest message that ask or agree, copied exactly.",
    inputSchema: z.object({
      sourceRef: z.string().min(1).max(80),
      kind: z.enum(KINDS),
      parentAgreement: z.string().min(1).max(300),
    }),
    monetary: false,
    touchesChildContent: false,
    handler: async (input, ctx) => {
      requireScope(ports, ctx.familyId);
      if (!quotesParent(ports.parentWords, input.parentAgreement)) {
        throw new Error(
          "parentAgreement is not in the parent's latest message. Only call add_watch_target with their own words from this message asking for or agreeing to the watch. If they have not agreed yet, ask them and stop.",
        );
      }
      const source = (await candidates(ports)).find((c) => c.sourceRef === input.sourceRef);
      if (!source) {
        throw new Error(
          'That sourceRef is not one Hale knows for this family. Call list_watch_targets and use a sourceRef it returned.',
        );
      }
      const db = ports.database;
      await db
        .insert(schema.providerWatchTargets)
        .values({ providerHost: source.provider, sourceUrl: source.url, kind: input.kind })
        .onConflictDoUpdate({
          target: [schema.providerWatchTargets.sourceUrl, schema.providerWatchTargets.kind],
          set: { enabled: true },
        });
      const [target] = await db
        .select({ id: schema.providerWatchTargets.id })
        .from(schema.providerWatchTargets)
        .where(
          and(
            eq(schema.providerWatchTargets.sourceUrl, source.url),
            eq(schema.providerWatchTargets.kind, input.kind),
          ),
        )
        .limit(1);
      if (!target) throw new Error('The watch could not be saved.');
      await db
        .insert(schema.familyWatchSubscriptions)
        .values({
          familyId: ports.familyId,
          parentUserId: ports.parentUserId,
          targetId: target.id,
          sourceRef: source.sourceRef,
          consentConversationId: ports.conversationId,
          consentMessageSha256: createHash('sha256').update(ports.parentWords).digest('hex'),
          consentQuote: input.parentAgreement.slice(0, 300),
        })
        .onConflictDoNothing();
      const [live] = (await liveWatches(ports)).filter((w) => w.targetId === target.id);
      return {
        watching: true as const,
        watchId: live?.watchId ?? null,
        provider: source.provider,
        kind: input.kind,
      };
    },
  });

  const remove = defineTool({
    name: REMOVE_WATCH_TARGET_TOOL,
    description:
      "Turn off one of this family's provider-page watches when the parent says, in any words or language, that they no longer want it. `watchId` comes from list_watch_targets.",
    inputSchema: z.object({ watchId: z.string().min(1).max(64) }),
    monetary: false,
    touchesChildContent: false,
    handler: async (input, ctx) => {
      requireScope(ports, ctx.familyId);
      const watch = (await liveWatches(ports)).find((w) => w.watchId === input.watchId);
      if (!watch) {
        throw new Error(
          "That watchId is not one of this family's live watches. Call list_watch_targets and use a watchId it returned.",
        );
      }
      const db = ports.database;
      await db
        .update(schema.familyWatchSubscriptions)
        .set({ removedAt: new Date() })
        .where(eq(schema.familyWatchSubscriptions.id, watch.watchId));
      const [still] = await db
        .select({ id: schema.familyWatchSubscriptions.id })
        .from(schema.familyWatchSubscriptions)
        .where(
          and(
            eq(schema.familyWatchSubscriptions.targetId, watch.targetId),
            isNull(schema.familyWatchSubscriptions.removedAt),
          ),
        )
        .limit(1);
      if (!still) {
        await db
          .update(schema.providerWatchTargets)
          .set({ enabled: false })
          .where(eq(schema.providerWatchTargets.id, watch.targetId));
      }
      return { stopped: true as const, provider: watch.provider, kind: watch.kind };
    },
  });

  return [list, add, remove];
}

/**
 * The coach skill on disk does not name these tools, so with the flag off its bytes (and
 * the channel eval's cache keys) are unchanged. With BROWSER_USE_WATCH_ENABLED on, the
 * names are appended, the way augmentCoachSkillForAutonomySwitchOff does it.
 */
export function augmentCoachSkillForProviderWatch(skill: Skill, enabled: boolean): Skill {
  if (!enabled) return skill;
  const missing = WATCH_TOOL_NAMES.filter((name) => !skill.meta.tools.includes(name));
  if (missing.length === 0) return skill;
  return { ...skill, meta: { ...skill.meta, tools: [...skill.meta.tools, ...missing] } };
}
