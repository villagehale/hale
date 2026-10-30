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
 * skill, its tool list and the eval cache stay byte-identical. Choosing "link" is simply
 * not calling this verb: the cited ref goes out as the link preview it always did.
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
      "Send ONE find from this turn as a tappable iMessage card instead of a plain link preview. Use it when one venue's page is the answer — even if that page lists several classes or sessions; skip it (just cite the [link-…] ref as usual) when the answer compares different venues or pages. `ref` is the find's ref from a tool result this turn. `title` is the card's line in your own words and the parent's language: what it is, and when/where if known, at most 64 characters, no URL. Still cite the same ref in your message. One card per turn; the last call wins.",
    inputSchema: z.object({ ref: z.string().min(1), title: z.string().min(1) }),
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

/** Lit only: list the verb in the skill's tool allowlist. Dark leaves the skill untouched. */
export function augmentCoachSkillForExperienceCards(skill: Skill, enabled: boolean): Skill {
  if (!enabled || skill.meta.tools.includes(EXPERIENCE_CARD_TOOL)) return skill;
  return { ...skill, meta: { ...skill.meta, tools: [...skill.meta.tools, EXPERIENCE_CARD_TOOL] } };
}
