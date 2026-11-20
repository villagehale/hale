// The coach turn's `helpLines` (VIL-589), for every eval that replicates the coach context.
// Production reads the family's row (readHealthPlace), places it with healthPlaceOf and hands
// the model healthLineFacts(place).facts; a fixture's `location` IS that row, so this makes
// the same two calls on it. A group turn reads no place, as channel/coach/runtime.ts does.
// Never a literal: a US fixture cannot be handed 811.

import { register } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';

const CHANNEL = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'web',
  'lib',
  'channel',
);

let modules;

/** One after the other: two tsImports in flight at once can leave one untransformed. */
async function load() {
  // place.ts imports its postal tables without `with { type: 'json' }`.
  register(new URL('./json-module-hook.mjs', import.meta.url), import.meta.url);
  const { healthPlaceOf } = await tsImport(
    join(CHANNEL, 'off-domain', 'place.ts'),
    import.meta.url,
  );
  const { healthLineFacts } = await tsImport(join(CHANNEL, 'health-line.ts'), import.meta.url);
  return { healthPlaceOf, healthLineFacts };
}

/**
 * Where a fixture's family is for the health line, by production's own healthPlaceOf: the
 * value a runtime-driving eval's `loadHealthPlace` port returns.
 * @param {{ country: string | null; province: string | null }} location  the fixture's family row
 */
export async function fixtureHealthPlace(location) {
  modules ??= load();
  const { healthPlaceOf } = await modules;
  return healthPlaceOf({
    country: location.country,
    province: location.province,
    postalCode: null,
    areaCoarse: null,
  });
}

/**
 * @param {{ country: string | null; province: string | null }} location  the fixture's family row
 * @param {'direct' | 'group'} audience
 */
export async function coachHelpLines(location, audience = 'direct') {
  modules ??= load();
  const { healthLineFacts } = await modules;
  return healthLineFacts(audience === 'group' ? null : await fixtureHealthPlace(location)).facts;
}
