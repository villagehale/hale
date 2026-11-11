/** The subject findFamilyActivities searches when the model gave none (apps/web/lib/village/live.ts). */
const DEFAULT_SUBJECT = 'local activities for kids';

/**
 * VIL-567 · the `search_village` handler a `findTurnPrompt` fixture answers with
 * (run-coach-channel-eval.mjs).
 *
 * The model's query and window go through the PRODUCTION de-identifier first, with the
 * family facts findFamilyActivities hands it (apps/web/lib/village/live.ts), and the window
 * recorded for the day judge is the one that crossed. A fake that recorded the raw window
 * graded a day the gate had scrubbed as if the search had seen it.
 *
 * A window gets the fixture's `village`; a search with no window searches the whole year in
 * production, so it gets `yearVillage`. A refusal is answered as production answers it: no
 * candidates, and the refusal as `liveRead`.
 */
export function gatedSearchVillageHandler({
  deidentify,
  family,
  record,
  village,
  yearVillage,
  toolOutputs,
  linkRef,
}) {
  return async (input) => {
    const gated = deidentify.deidentifyActivityQuery({
      subject: input.query ?? DEFAULT_SUBJECT,
      window: input.window ?? null,
      town: family.town,
      stage: family.stage,
      householdNames: family.householdNames,
      today: family.today,
    });
    if (!gated.ok) {
      record('search_village', { window: null, refusal: gated.refusal });
      const refused = {
        candidates: [],
        inVerification: 0,
        standingOption: null,
        liveRead: gated.refusal,
      };
      toolOutputs.push(refused);
      return refused;
    }
    const window = gated.query.window;
    record('search_village', { window });
    const found = window ? village : yearVillage;
    const shown = {
      candidates: (found.candidates ?? []).map(({ url, ...candidate }) =>
        url ? { ...candidate, ref: linkRef(url) } : candidate,
      ),
      inVerification: found.inVerification ?? 0,
      standingOption: found.standingOption ?? null,
      liveRead: 'verified',
    };
    toolOutputs.push(shown);
    return shown;
  };
}
