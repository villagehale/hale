import type { ExtractedChild } from './extract';

/**
 * VIL-237 · M2 — the seam M3 lands behind. Once a family is provisioned, intake hands
 * off to "the radar": the first real thing Hale has spotted for these kids in this
 * area, said back to the parent before the watch-offer.
 *
 * M2 ships the INTERFACE and a placeholder implementation, deliberately, because the
 * alternative is worse than a placeholder. A composed-sounding "I found swim
 * registration at your local pool" with nothing behind it is a fabrication in the
 * first minute of a family's relationship with Hale, and it would be indistinguishable
 * from the real thing once M3 lands — so a regression would be invisible. The
 * placeholder instead says the true thing: nothing has been looked up yet.
 *
 * The contract is typed so M3 is a swap, not a rewrite: the machine calls
 * `compose(...)` and texts whatever `message` comes back.
 */

export interface RadarInput {
  familyId: string;
  children: readonly ExtractedChild[];
  /** The coarse area (FSA), never the full postal code (rule #1). */
  areaCoarse: string | null;
}

export interface RadarPayload {
  message: string;
  /** How many real, grounded items the message is built from. Zero for the
   * placeholder — the honest signal that nothing has been looked up. */
  itemCount: number;
}

export interface RadarComposer {
  compose(input: RadarInput): Promise<RadarPayload>;
}

/** The deterministic, honest fallback: claims nothing, promises only what M2 can do. */
export const placeholderRadarComposer: RadarComposer = {
  async compose() {
    return {
      message: "I've got your family set up. I'm still learning what's on around you.",
      itemCount: 0,
    };
  },
};
