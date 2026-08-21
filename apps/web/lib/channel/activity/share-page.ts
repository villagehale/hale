import { randomBytes } from 'node:crypto';
import { type Database, schema } from '@hale/db';
import { appBaseUrl } from '~/lib/cron/email-compliance';
import type { DeepSlot } from './deep';

/**
 * WHERE THE REST OF THE SCHEDULE GOES.
 *
 * A deep pass that opens a venue's schedule page comes back with eight class times, four
 * prices and a registration deadline. Two segments of SMS hold about three hundred
 * characters. The gap between those two numbers is the whole reason this file exists: the
 * text carries the best one or two, and everything else goes on a page the parent can
 * open — rather than being silently dropped, which would make the deep pass an expensive
 * way to produce the same short answer.
 *
 * IT REUSES THE SHARE SURFACE THAT ALREADY EXISTS, and this was a deliberate choice over
 * writing a new one. `/a/:token` (app/a/[token]/page.tsx) is the public, unauthenticated
 * per-activity card: it resolves a `village_candidates.share_token`, FAILS CLOSED on a
 * child-attributed row, projects through the closed `toPublicActivity` allow-list, has an
 * OG image, and carries the not-found state. Every one of those is a privacy property
 * that took review to get right (rule #1), and a second page system would be a second
 * place to get them wrong. The other two candidates were rejected on fit rather than
 * effort: `/w/:token` renders a WEEK, and `/picks/:token` renders a family's ENDORSED
 * shortlist through an inner join this row would never satisfy.
 *
 * SO A DEEP FIND IS A VILLAGE CANDIDATE, which it always was — "one discovered local
 * resource (a class, group, drop-in, program) the village agent surfaces for a family" is
 * the row's own description, and the deep pass is a discovery. It is written with
 * `run_type: 'search'` so it never soft-retires the standing radar feed, `child_id: null`
 * so the public loader can serve it at all, and `source: 'activity_deep'` so its
 * provenance is legible next to the radar's own finds.
 *
 * THE SUMMARY IS ASSEMBLED WHOLE-SLOT-AT-A-TIME, never truncated mid-row. `toPublicActivity`
 * caps a summary at 600 characters, and a cut that lands inside "$124 per te" publishes a
 * wrong price to a public page. So slots are added while the whole next one still fits and
 * the count says how many were left off.
 */

/** How many slots the SMS itself carries. Beyond this the parent gets a page. Two,
 * because the follow-up leads with the best find and one alternative is the most a
 * person reads on a phone — the same never-a-directory rule the inline lane holds. */
export const SLOTS_IN_TEXT = 2;

/** The public card's own cap (village/public.ts `SUMMARY_MAX`), mirrored here so the
 * assembly can stop before it rather than be cut by it. */
const SUMMARY_MAX = 600;

/** What the sweep needs back. `skipped` is named rather than a null URL: a share page
 * that could not be written is a thing the log should say, not a link that silently
 * becomes absent (rule #11). */
export type ActivitySharePage =
  | { status: 'minted'; url: string; slots: number }
  | { status: 'skipped'; reason: 'nothing_to_share' | 'write_failed' };

export interface ActivitySharePorts {
  /** Writes the candidate row and returns its id. Injected so the sweep's tests drive
   * the shape without a database. */
  writeCandidate(
    database: Database,
    row: {
      familyId: string;
      title: string;
      summary: string;
      sourceUrl: string | null;
      shareToken: string;
    },
  ): Promise<string>;
  audit(database: Database, row: Record<string, unknown>): Promise<void>;
}

/** One slot as a parent reads it, on one line. */
export function slotLine(slot: DeepSlot): string {
  const parts = [slot.name];
  if (slot.when) parts.push(slot.when);
  if (slot.price) parts.push(slot.price);
  if (slot.registration) parts.push(slot.registration);
  return parts.join(' - ');
}

/**
 * The page's body: every slot that fits, whole. Returns the text and how many slots it
 * actually carries, so a caller can say "and 3 more" honestly rather than guess.
 */
export function shareSummary(slots: readonly DeepSlot[]): { summary: string; carried: number } {
  const lines: string[] = [];
  for (const slot of slots) {
    const line = slotLine(slot);
    const next = [...lines, line].join('\n');
    if (next.length > SUMMARY_MAX) break;
    lines.push(line);
  }
  return { summary: lines.join('\n'), carried: lines.length };
}

/**
 * Put the schedule somewhere the parent can open it, and hand back the link.
 *
 * The token is `randomBytes(18).base64url` — the same mint `ensureShareToken` and
 * `ensureActivityShareToken` use, and the same property: it identifies no child and no
 * parent, so the page it unlocks is a schedule and nothing else.
 */
export async function mintActivitySharePage(
  database: Database,
  input: { familyId: string; slots: readonly DeepSlot[] },
  ports: ActivitySharePorts,
): Promise<ActivitySharePage> {
  const { summary, carried } = shareSummary(input.slots);
  const top = input.slots[0];
  if (!top || carried === 0) return { status: 'skipped', reason: 'nothing_to_share' };

  const shareToken = randomBytes(18).toString('base64url');
  let candidateId: string;
  try {
    candidateId = await ports.writeCandidate(database, {
      familyId: input.familyId,
      title: top.sourceName,
      summary,
      // The page the top slot was read off — the card renders it as "their page", which
      // is the honest sourcing the whole lane holds.
      sourceUrl: top.sourceUrl,
      shareToken,
    });
  } catch (err) {
    // The text still goes out, one find lighter. A share page that failed to write must
    // never take the follow-up down with it.
    console.error(
      { err, familyId: input.familyId },
      'activity share page: could not write the candidate - sending the text without a link',
    );
    return { status: 'skipped', reason: 'write_failed' };
  }

  await ports.audit(database, {
    familyId: input.familyId,
    actor: 'system',
    actionTaken: 'activity_followup_shared',
    targetTable: 'village_candidates',
    targetId: candidateId,
    // A COUNT, never the finds — an audit row is read by ops and by a right-to-access
    // export, and neither needs the venue names (rule #1).
    after: { slots: carried },
  });

  return { status: 'minted', url: `${appBaseUrl()}/a/${shareToken}`, slots: carried };
}

/**
 * The link, as a tail on a composed message.
 *
 * CODE-OWNED, like {@link import('~/lib/channel/opt-out').withOptOut} and for the same
 * reason: the composer is gated on never texting a link (followup-note.ts `LINK_SHAPE`),
 * and that gate is right — a model that may write URLs will eventually write a wrong one.
 * So the model writes the sentence and never sees a URL, and the one link Hale sends is
 * assembled here from a token this process just minted.
 */
export function withSharePage(body: string, url: string): string {
  return `${body}\nThe rest: ${url}`;
}

/** The production writer. */
export function defaultActivitySharePorts(): ActivitySharePorts {
  return {
    writeCandidate: async (database, row) => {
      const [written] = await database
        .insert(schema.villageCandidates)
        .values({
          familyId: row.familyId,
          // NULL, always. A child-attributed candidate can never be made public, and the
          // loader fails closed on one — so a deep find is family-wide by construction
          // rather than by a check somebody has to remember (rule #1).
          childId: null,
          title: row.title,
          kind: 'class',
          summary: row.summary,
          sourceUrl: row.sourceUrl,
          source: 'activity_deep',
          // Read off the operator's own page rather than inferred, which is the highest
          // this pipeline claims — and still not "verified by us".
          confidence: 0.9,
          shareToken: row.shareToken,
          // A parent-triggered lane, so it is a `search` run: supersession is scoped by
          // run type, and a deep find must never soft-retire the standing radar feed.
          runType: 'search',
        })
        .returning({ id: schema.villageCandidates.id });
      if (!written) throw new Error('activity share page: candidate insert returned no row');
      return written.id;
    },
    audit: async (database, row) => {
      await database.insert(schema.auditLog).values(row as never);
    },
  };
}
