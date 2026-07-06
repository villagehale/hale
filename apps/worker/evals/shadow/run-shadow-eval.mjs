// Shadow-prompt eval (prod-truth A/B) — SCAFFOLD.
//
// Runs baseline vs candidate prompt versions over the same inputs, keeps only
// disagreements, judges them, and writes a switch recommendation. Read-only: it
// NEVER mutates the live prompt. See README.md.
//
// Rule #1: refuses real traffic. Runs on SYNTHETIC fixtures until a verified,
// fail-closed redactor is built and reviewed (then --redacted-source unlocks).
//
// Usage:
//   node evals/shadow/run-shadow-eval.mjs            # synthetic fixtures (default)
//   node evals/shadow/run-shadow-eval.mjs --redacted-source   # refused until redactor exists

import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE_PATH = join(HERE, 'shadow-STATE.md');
const TARGET_DISAGREEMENTS = 50;

if (process.argv.includes('--redacted-source')) {
  console.error(
    'REFUSED: real/redacted traffic is not enabled. Rule #1 requires a verified fail-closed\n' +
      'redactor (no name/DOB/precise-location ever reaches a prompt) + explicit sign-off.\n' +
      'Build + review that first; until then this eval runs on synthetic fixtures only.',
  );
  process.exit(2);
}

// ── SEAM 1: the two prompt versions under comparison ─────────────────────────
// Replace with a real load: baseline = the live Langfuse version, candidate =
// the proposed one. Return an async fn (input) => output for each. The synthetic
// stand-ins below differ only in a rule, so the harness produces real disagreements.
async function loadPromptVersions() {
  const classify = (bias) => async (input) => {
    // Stand-in "classifier": baseline is stricter about escalating fevers.
    const feverish = /fever|39|40|temperature/i.test(input.text);
    const urgent = feverish || (bias === 'candidate' && /rash|not eating/i.test(input.text));
    return { event_type: urgent ? 'health_urgent' : 'health_routine', confidence: urgent ? 0.9 : 0.5 };
  };
  return { baseline: classify('baseline'), candidate: classify('candidate') };
}

// ── SEAM 2: representative inputs (half edge-case, half high-frequency) ───────
// Replace with a sampler over SYNTHETIC fixtures (or, once the redactor exists,
// redacted prod shapes). No real PII here.
function sampleInputs() {
  return [
    { id: 'e1', text: 'baby has a 39.5 fever, what do I do' },
    { id: 'e2', text: 'toddler has a rash and is not eating today' },
    { id: 'e3', text: 'when is the next well-baby visit' },
    { id: 'e4', text: 'she slept 6 hours straight last night!' },
    { id: 'e5', text: 'temperature reads 40 on the forehead thermometer' },
  ];
}

// A material disagreement = the decision differs (not just phrasing).
function disagrees(a, b) {
  return a.event_type !== b.event_type;
}

// ── judge (cheap tier in the real version; deterministic stub here) ──────────
function judge(input, base, cand) {
  // Real version: a Haiku call scoring which output is better + why. Stub prefers
  // the more cautious health call, as a placeholder rubric.
  const rank = (o) => (o.event_type === 'health_urgent' ? 1 : 0);
  const winner = rank(cand) === rank(base) ? 'tie' : rank(cand) > rank(base) ? 'candidate' : 'baseline';
  return { winner, why: `input=${input.id}: base=${base.event_type} cand=${cand.event_type}` };
}

async function main() {
  const { baseline, candidate } = await loadPromptVersions();
  const inputs = sampleInputs();
  const disagreements = [];
  for (const input of inputs) {
    const [b, c] = await Promise.all([baseline(input), candidate(input)]);
    if (disagrees(b, c)) disagreements.push({ input, base: b, cand: c, verdict: judge(input, b, c) });
    if (disagreements.length >= TARGET_DISAGREEMENTS) break;
  }

  const tally = disagreements.reduce(
    (acc, d) => ((acc[d.verdict.winner] = (acc[d.verdict.winner] || 0) + 1), acc),
    {},
  );
  const runHash = createHash('sha256').update(JSON.stringify(inputs)).digest('hex').slice(0, 8);
  const lines = [
    '# shadow-prompt STATE',
    `Run ${runHash} · ${disagreements.length}/${inputs.length} inputs disagreed · target ${TARGET_DISAGREEMENTS}`,
    '',
    `## tally  candidate:${tally.candidate || 0}  baseline:${tally.baseline || 0}  tie:${tally.tie || 0}`,
    '',
    '## disagreements',
    ...disagreements.map((d) => `- ${d.verdict.why} → winner: ${d.verdict.winner}`),
    '',
    '## recommendation',
    disagreements.length < TARGET_DISAGREEMENTS
      ? `KEEP ACCUMULATING — ${disagreements.length}/${TARGET_DISAGREEMENTS} disagreements so far.`
      : (tally.candidate || 0) > (tally.baseline || 0) * 1.5
        ? 'CANDIDATE favored — review the disagreements, then consider switching.'
        : 'NO CLEAR WIN — do not switch on this evidence.',
  ];
  writeFileSync(STATE_PATH, `${lines.join('\n')}\n`);
  console.log(lines.join('\n'));
  console.log(`\n(state written to ${STATE_PATH})`);
}

await main();
