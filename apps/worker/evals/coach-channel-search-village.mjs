/** The subject findFamilyActivities searches when the model gave none (apps/web/lib/village/live.ts). */
const DEFAULT_SUBJECT = 'local activities for kids';

/**
 * What one recorded `search_village` call searched, as the day judge reads it: the window
 * text and the `date` that crossed, or null for a search of the whole year.
 */
export function searchedWindow(call) {
  return [call.window, call.date].filter(Boolean).join(' · ') || null;
}

/**
 * VIL-567 · the `search_village` handler a `findTurnPrompt` fixture answers with
 * (run-coach-channel-eval.mjs).
 *
 * The model's query, window and date go through the PRODUCTION de-identifier first, with
 * the family facts findFamilyActivities hands it (apps/web/lib/village/live.ts), and the
 * window and date recorded for the day judge are the ones that crossed. A fake that
 * recorded the raw window graded a day the gate had scrubbed as if the search had seen it.
 *
 * An `area` goes through the production place gate (named-area.ts `searchableArea`)
 * before anything is searched. Production reads the place with a model first; no find-day
 * fixture names a place, so the read here knows the family's own town and calls anything
 * else not a place. A recording once put "today" in `area`, which production refuses.
 *
 * A window or a date gets the fixture's `village`; a search with neither searches the
 * whole year in production, so it gets `yearVillage`. A refusal is answered as production
 * answers it: no candidates, and the refusal as `liveRead`.
 */
export function gatedSearchVillageHandler({
  deidentify,
  namedArea,
  family,
  record,
  village,
  yearVillage,
  toolOutputs,
  linkRef,
}) {
  const refuse = (refusal) => {
    record('search_village', { window: null, date: null, refusal });
    const refused = { candidates: [], inVerification: 0, standingOption: null, liveRead: refusal };
    toolOutputs.push(refused);
    return refused;
  };
  return async (input) => {
    let town = family.town;
    if (input.area !== undefined) {
      const home = input.area.trim().toLowerCase() === family.town.toLowerCase();
      const place = namedArea.searchableArea(
        home
          ? { locality: family.town, region: null, granularity: 'locality' }
          : { locality: null, region: null, granularity: 'not_a_place' },
        family.householdNames,
      );
      if (!place.ok) return refuse(place.refusal);
      town = place.label;
    }
    const gated = deidentify.deidentifyActivityQuery({
      subject: input.query ?? DEFAULT_SUBJECT,
      window: input.window ?? null,
      town,
      stage: family.stage,
      householdNames: family.householdNames,
      today: family.today,
      date: input.date ?? null,
    });
    if (!gated.ok) return refuse(gated.refusal);
    const searched = { window: gated.query.window, date: gated.query.date ?? null };
    record('search_village', searched);
    const found = searchedWindow(searched) ? village : yearVillage;
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
