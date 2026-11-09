/**
 * What the intake searches (`intake-live-ground`, `intake-official-ground`) are sent: the
 * de-identified question, and where the family is as a country and, when known, a
 * province or state (VIL-592). Without the country a US parent was handed Canadian
 * sources and the 811 line, which in the US is the call-before-you-dig number.
 *
 * Never finer than a province or state, and never the postal code it was read from.
 * No imports, so the eval runner sends the same request (run-intake-ground-eval.mjs).
 */

export interface GroundPlace {
  /** "Canada" or "United States", from the postal tables. */
  readonly countryName: string;
  /** The postal table's name for the province or state, or null when it has none. */
  readonly provinceOrState: string | null;
}

export function groundUserMessage(question: string, place: GroundPlace | null): string {
  return JSON.stringify({
    question,
    ...(place === null
      ? {}
      : {
          place: {
            country: place.countryName,
            ...(place.provinceOrState === null ? {} : { province_or_state: place.provinceOrState }),
          },
        }),
  });
}
