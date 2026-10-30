import { type RegisteredTool, type Skill, defineTool } from '@hale/agent';
import { z } from 'zod';
import type { RefLink } from './activity-links';

/**
 * VIL-497 — the product path for Linq experience cards (wire: VIL-480 / #965).
 *
 * Hale's AI decides, per find, whether a page goes out as a tappable experience card
 * (Linq `link`/`open`) or as the existing link preview, and writes the card's title.
 * Nothing here holds copy: the title is the model's, free (times and places allowed —
 * Design lock), and the URL is never a model argument. The model names a `ref` that a
 * tool returned THIS turn; the runtime resolves it to the page, exactly the way a cited
 * `[link-…]` marker is resolved (activity-links.ts). An unknown ref is refused as a
 * sentence the model reads and answers by calling again.
 *
 * Registered only while `LINQ_EXPERIENCES_ENABLED` is lit, on a 1:1 turn, so the dark
 * skill, its tool list and the eval cache stay byte-identical. The lit turn also appends
 * `experience-card-coach` (VIL-500): citing a ref still attaches the page, and for one
 * venue's page that citation does not replace the card. Comparing different venues or
 * pages is the path that stays a plain link — not calling this verb.
 */

export const EXPERIENCE_CARD_TOOL = 'share_experience_card';
const TITLE_MAX = 64;

export interface ExperienceCardIntent {
  url: string;
  title: string;
}

/** Everything wrong with a proposed card, phrased for the model. Empty → sendable. */
export function experienceCardViolations(
  input: { ref: string; title: string },
  links: readonly RefLink[],
): string[] {
  const out: string[] = [];
  const ref = input.ref.trim().toLowerCase();
  if (!links.some((link) => link.ref.toLowerCase() === ref)) {
    out.push(
      'That ref is not one a tool returned this turn. Use the exact ref of the find the card is for.',
    );
  }
  const title = input.title.trim();
  if (title === '') out.push('The title was empty.');
  if (title.length > TITLE_MAX) out.push(`The title is over ${TITLE_MAX} characters.`);
  if (/https?:\/\/|www\./i.test(title)) out.push('The title contains a link. Do not write one.');
  return out;
}

export function shareExperienceCardTool(args: {
  /** The turn's ref→page table, read at call time (finds land mid-turn). */
  links: () => readonly RefLink[];
  onCard: (card: ExperienceCardIntent) => void;
}): RegisteredTool {
  return defineTool({
    name: EXPERIENCE_CARD_TOOL,
    description:
      "Call this when the answer is one venue's page from this turn, even if that page lists several classes or sessions. Citing that page's [link-…] ref in the reply does not replace this call. Do both. Do not call this when the answer compares different venues or different pages; cite each ref and stop. `ref` is the exact ref a tool returned this turn. `title` is the card's line in your own words and the parent's language, at most 64 characters, no URL. One card per turn; the last call wins.",
    inputSchema: z.object({ ref: z.string().min(1), title: z.string().min(1) }),
    inputExamples: [{ ref: 'link-1a2b3c', title: 'Sat kids art at the studio' }],
    monetary: false,
    registersOnly: true,
    // Reads no child row; the title passes the same teen redaction as the reply.
    touchesChildContent: false,
    handler: async (input) => {
      const links = args.links();
      const violations = experienceCardViolations(input, links);
      if (violations.length > 0) {
        throw new Error(
          `That card cannot be sent. ${violations.join(' ')} Call ${EXPERIENCE_CARD_TOOL} again with a fixed one, or just cite the ref for a link preview.`,
        );
      }
      const ref = input.ref.trim().toLowerCase();
      const link = links.find((l) => l.ref.toLowerCase() === ref) as RefLink;
      args.onCard({ url: link.url, title: input.title.trim() });
      return { registered: true as const };
    },
  });
}

/**
 * Lit only: list the verb and append the card addendum. `null` (dark, or a group turn)
 * returns the same skill object, so the 1:1 disk bytes and the eval cache stay put.
 */
export function augmentCoachSkillForExperienceCards(skill: Skill, addendum: Skill | null): Skill {
  if (addendum === null || skill.meta.tools.includes(EXPERIENCE_CARD_TOOL)) return skill;
  return {
    ...skill,
    meta: { ...skill.meta, tools: [...skill.meta.tools, EXPERIENCE_CARD_TOOL] },
    instructions: `${skill.instructions}\n\n${addendum.instructions}`,
  };
}
