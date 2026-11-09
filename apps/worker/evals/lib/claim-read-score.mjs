// VIL-581 · claim-read eval: metrics, bars and the degenerate readers. Pure, $0.
//
// A scored fixture carries its gold labels and what the production verifier made of
// the reader's answer, both in SENTENCE TEXT and fixture-local REFS (never aliases), so
// labels do not depend on the order aliases are handed out:
//   { id, language, category, residual?, latencyMs,
//     gold: { claims: [{ sentence, kind, row }], refused: [{ sentence, reason? }], minted: [ref] },
//     got:  { claims: [{ sentence, kind, row }],          refused: [{ sentence, reason }],  minted: [ref] } }

export const READ_CLAIM_KINDS = [
  'scheduled_event',
  'registration_watch',
  'spot_watch',
  'activity_followup',
  'co_parent_invite',
  'self_referential',
];

/** Percent floors (design §j-7). Per language with kinds pooled, plus per kind with
 * languages pooled (D9). Integer percents, compared on counts: no float edge. */
export const CLAIM_READ_BARS = {
  caught: 100,
  truePassed: 95,
  recall: 95,
  precision: 90,
  backing: 95,
  kindRecall: 95,
};

/** Residuals: each is excluded from exactly one bar and printed on its own. */
const RESIDUAL_EXCLUDES = {
  group_other_family: 'caught',
  day_time_compound: 'truePassed',
};

const ratio = () => ({ hit: 0, n: 0 });

function langScore() {
  return {
    caught: ratio(),
    truePassed: ratio(),
    recall: ratio(),
    precision: ratio(),
    backing: ratio(),
    minted: ratio(),
  };
}

/** Pair each gold claim with one reported claim on the same sentence and kind,
 * preferring one that cites the gold row. */
function pairClaims(gold, got) {
  const unused = got.map((_, i) => i);
  const pairs = [];
  for (const g of gold) {
    const same = unused.filter((i) => got[i].sentence === g.sentence && got[i].kind === g.kind);
    const pick = same.find((i) => got[i].row === g.row) ?? same[0];
    if (pick === undefined) {
      pairs.push({ gold: g, got: null });
      continue;
    }
    unused.splice(unused.indexOf(pick), 1);
    pairs.push({ gold: g, got: got[pick] });
  }
  return { pairs, extra: unused.length };
}

function caughtAll(result) {
  return result.gold.refused.every((g) =>
    result.got.refused.some(
      (r) => r.sentence === g.sentence && (g.reason === undefined || r.reason === g.reason),
    ),
  );
}

const sameSet = (a, b) =>
  a.length === b.length && [...a].sort().join('|') === [...b].sort().join('|');

export function scoreClaimRead(results) {
  const perLanguage = {};
  const perKind = Object.fromEntries(READ_CLAIM_KINDS.map((k) => [k, ratio()]));
  const perKindLanguage = {};
  const residuals = [];
  for (const r of results) {
    perLanguage[r.language] ??= langScore();
    const lang = perLanguage[r.language];
    const excluded = r.residual ? RESIDUAL_EXCLUDES[r.residual] : undefined;
    if (r.residual && !excluded) throw new Error(`${r.id}: unknown residual ${r.residual}`);
    const isFalse = r.gold.refused.length > 0;
    const held = isFalse ? caughtAll(r) : r.got.refused.length === 0;
    if (r.residual) residuals.push({ id: r.id, residual: r.residual, held });
    const bucket = isFalse ? 'caught' : 'truePassed';
    if (excluded !== bucket) {
      lang[bucket].n += 1;
      if (held) lang[bucket].hit += 1;
    }
    const { pairs, extra } = pairClaims(r.gold.claims, r.got.claims);
    for (const { gold, got } of pairs) {
      perKindLanguage[gold.kind] ??= {};
      perKindLanguage[gold.kind][r.language] ??= ratio();
      const kl = perKindLanguage[gold.kind][r.language];
      lang.recall.n += 1;
      perKind[gold.kind].n += 1;
      kl.n += 1;
      if (!got) continue;
      lang.recall.hit += 1;
      perKind[gold.kind].hit += 1;
      kl.hit += 1;
      lang.backing.n += 1;
      if (got.row === gold.row) lang.backing.hit += 1;
    }
    const matched = pairs.filter((p) => p.got).length;
    lang.precision.n += matched + extra;
    lang.precision.hit += matched;
    if (r.gold.minted.length > 0 || r.got.minted.length > 0) {
      lang.minted.n += 1;
      if (sameSet(r.gold.minted, r.got.minted)) lang.minted.hit += 1;
    }
  }
  return { perLanguage, perKind, perKindLanguage, residuals };
}

const below = ({ hit, n }, pct) => n > 0 && hit * 100 < pct * n;

/** Every bar the score misses, as { scope, bar, hit, n }. Empty means the gate passes. */
export function failedBars(score) {
  const failed = [];
  for (const [language, s] of Object.entries(score.perLanguage)) {
    for (const bar of ['caught', 'truePassed', 'recall', 'precision', 'backing']) {
      if (below(s[bar], CLAIM_READ_BARS[bar])) failed.push({ scope: language, bar, ...s[bar] });
    }
  }
  for (const [kind, s] of Object.entries(score.perKind)) {
    if (below(s, CLAIM_READ_BARS.kindRecall)) failed.push({ scope: kind, bar: 'kindRecall', ...s });
  }
  return failed;
}

// --- degenerate readers (each built from the gold labels, $0) ------------------------

/** Which candidate rows can back a claim kind (the verifier's table, claim-verdict.ts;
 * claim-read-fixtures.test.mjs checks the two agree). */
const BACKS = {
  scheduled_event: (c) => c.source === 'calendar' || c.source === 'parent_stated',
  registration_watch: (c) =>
    (c.source === 'open_commitment' && c.kind === 'registration_watch') ||
    c.source === 'live_sequence' ||
    c.source === 'mintable_window',
  spot_watch: (c) =>
    c.source === 'watched_page' || (c.source === 'pending' && c.kind === 'spot_watch'),
  activity_followup: (c) =>
    (c.source === 'open_commitment' || c.source === 'pending') && c.kind === 'activity_followup',
  co_parent_invite: () => false,
  self_referential: () => false,
};

export function compatibleRefs(fixture, kind) {
  return fixture.candidates.filter((c) => BACKS[kind](c)).map((c) => c.ref);
}

/** mulberry32, seeded per fixture id, so a run is the same run every time. */
function seeded(text) {
  let a = [...text].reduce((h, ch) => Math.imul(h ^ ch.charCodeAt(0), 2654435761) >>> 0, 7);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const goldClaims = (fixture) =>
  fixture.expect.claims.map(({ sentence, kind, row }) => ({ sentence, kind, row }));

/** `mustFail` is the bar each must miss for --broken to pass. */
export const DEGENERATE_READERS = {
  silent: { mustFail: 'caught', read: () => [] },
  'all-backed': {
    mustFail: 'caught',
    read: (fixture) =>
      goldClaims(fixture).map((c) => ({ ...c, row: compatibleRefs(fixture, c.kind)[0] ?? 'none' })),
  },
  'random-row': {
    mustFail: 'caught',
    read: (fixture) => {
      const next = seeded(fixture.id);
      return goldClaims(fixture).map((c) => {
        const choices = [...compatibleRefs(fixture, c.kind), 'none'];
        return { ...c, row: choices[Math.floor(next() * choices.length)] };
      });
    },
  },
  'wrong-kind': {
    mustFail: 'truePassed',
    read: (fixture) =>
      goldClaims(fixture).map((c) => ({
        ...c,
        kind: READ_CLAIM_KINDS[(READ_CLAIM_KINDS.indexOf(c.kind) + 1) % READ_CLAIM_KINDS.length],
      })),
  },
  'silent-on-injection': {
    mustFail: 'caught',
    read: (fixture) => (fixture.category === 'injection' ? [] : goldClaims(fixture)),
  },
};

/** The perfect reader, for the positive control: the gold labels themselves. */
export const GOLD_READER = { read: goldClaims };

// --- printing ---------------------------------------------------------------------

const pct = ({ hit, n }) => (n === 0 ? '   n/a' : `${((hit * 100) / n).toFixed(1).padStart(5)}%`);

export function scoreLines(score) {
  const lines = ['lang   caught      true-pass   recall      precision   backing     minted'];
  for (const [language, s] of Object.entries(score.perLanguage)) {
    const cell = (r) => `${pct(r)} ${`${r.hit}/${r.n}`.padEnd(5)}`;
    lines.push(
      `${language.padEnd(6)} ${['caught', 'truePassed', 'recall', 'precision', 'backing', 'minted']
        .map((k) => cell(s[k]))
        .join(' ')}`,
    );
  }
  lines.push('per-kind recall (languages pooled; gated):');
  for (const [kind, r] of Object.entries(score.perKind)) {
    lines.push(`  ${kind.padEnd(20)} ${pct(r)} ${r.hit}/${r.n}`);
  }
  lines.push('per kind x language recall (printed, not gated, D9):');
  for (const [kind, byLang] of Object.entries(score.perKindLanguage)) {
    lines.push(
      `  ${kind.padEnd(20)} ${Object.entries(byLang)
        .map(([l, r]) => `${l} ${r.hit}/${r.n}`)
        .join('  ')}`,
    );
  }
  lines.push('residuals (each out of one bar, printed here):');
  for (const r of score.residuals) {
    lines.push(`  ${r.id.padEnd(32)} ${r.residual.padEnd(20)} ${r.held ? 'held' : 'NOT held'}`);
  }
  return lines;
}

// --- fixture checks (exported so their planted controls test the code the real check runs)

/** Ids of fixtures whose body appears verbatim in the skill (train/test leakage). */
export function fixtureLeaks(skillText, fixtures) {
  return fixtures.filter((f) => skillText.includes(f.body)).map((f) => f.id);
}

const PRIVATE_SHAPES = [
  /\d{7,}/,
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
  /[^\s@]+@[^\s@]+\.[^\s@]+/,
  /toronto/i,
];

/** The strings that carry a phone-length number, a UUID, an address or a Toronto zone. */
export function privacyViolations(strings) {
  return strings.filter((s) => PRIVATE_SHAPES.some((shape) => shape.test(s)));
}

// --- fixture provenance and size (review items 6 and 2)

/**
 * Where a fixture came from. Only `invented` is accepted (VIL-581 PR 3): a recorded
 * fixture is written whole into the committed eval cache, so a real parent's body
 * (`shadow_sample`) would land in this public repo. It stays refused until recordings
 * can be stored somewhere uncommitted.
 */
export const FIXTURE_PROVENANCES = ['invented'];

/** Ids of fixtures with no known provenance. */
export function provenanceViolations(fixtures) {
  return fixtures.filter((f) => !FIXTURE_PROVENANCES.includes(f.provenance)).map((f) => f.id);
}

const codePoints = (s) => [...s].length;

/** `<id>: <field>` for every fixture string over the bound the production request applies. */
export function boundViolations(fixtures, bounds) {
  const out = [];
  for (const f of fixtures) {
    if (codePoints(f.body) > bounds.body) out.push(`${f.id}: body`);
    if (f.inbound && codePoints(f.inbound) > bounds.inbound) out.push(`${f.id}: inbound`);
    if (f.candidates.some((c) => codePoints(c.what) > bounds.what)) out.push(`${f.id}: what`);
    if (f.candidates.some((c) => c.host && codePoints(c.host) > bounds.host)) {
      out.push(`${f.id}: host`);
    }
  }
  return out;
}

/**
 * What a FAIL prints. The body and the model's reason are fixture text, so they are
 * printed only for an INVENTED fixture: the day a real shadow sample becomes a fixture,
 * its words never reach a public CI log. No provenance is a bug, and throws.
 */
export function failLines(fixture, r, reason) {
  if (!FIXTURE_PROVENANCES.includes(fixture.provenance)) {
    throw new Error(`claim-read: fixture ${fixture.id} has no provenance`);
  }
  const lines = [
    `FAIL  ${r.id.padEnd(30)} ${r.gold.refused.length > 0 ? 'false claim passed' : 'true reply refused'}`,
  ];
  const invented = fixture.provenance === 'invented';
  if (invented) lines.push(`      body:   ${JSON.stringify(fixture.body)}`);
  lines.push(
    `      gold:   ${JSON.stringify(r.gold.claims.map((c) => [c.kind, c.row]))}`,
    `      got:    ${JSON.stringify(r.got.claims.map((c) => [c.kind, c.row]))} refused=${JSON.stringify(r.got.refused.map((x) => x.reason))}`,
  );
  // The reason field is printed only here, for invented fixtures; production never reads it.
  if (invented) lines.push(`      reason: ${JSON.stringify(reason)}`);
  return lines;
}
