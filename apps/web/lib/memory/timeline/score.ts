import type { FamilyMemoryExport } from '~/lib/rights/export-memory';
import {
  type Horizon,
  PROMPT_PATHS,
  type PromptPath,
  RAW_INPUT_PATHS,
  type SecretClass,
  type Timeline,
} from './fixtures';

/**
 * VIL-598 leg A · score one replayed timeline at one horizon. Pure: the inputs are the
 * text each prompt path was handed, the family's whole store, and its export copies.
 *
 * Every absence is scored only after its positive control: the planted words must be in
 * the store (or, for a correction, the export), or the probe is `vacuous` and fails the
 * gate. An absence check that can't find its subject anywhere proves nothing.
 */

export interface Finding {
  timeline: string;
  horizon: Horizon;
  text: string;
  /** The prompt path, `export` or `export.coparent`, or `store` for a vacuous probe. */
  where: string;
  secret?: SecretClass;
}

export interface TimelineScore {
  leaks: Finding[];
  stale: Finding[];
  contradictions: Finding[];
  recallMisses: Finding[];
  recall: { hit: number; expected: number };
  /** A forget or a delete whose words still reach a prompt. Also counted in `leaks`. */
  erasure: { held: number; expected: number };
  exportMisses: Finding[];
  vacuous: Finding[];
}

export interface ScoreInput {
  timeline: Timeline;
  horizon: Horizon;
  contexts: Record<PromptPath, string>;
  store: string;
  storeCounts: { facts: number; episodes: number };
  primaryExport: FamilyMemoryExport;
  coParentExport: FamilyMemoryExport | null;
}

function has(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

const MEMORY_PATHS = PROMPT_PATHS.filter((path) => !RAW_INPUT_PATHS.includes(path));

/** An injection or a third party's claim is read by the extractor to be refused. */
function pathsFor(secret: SecretClass): readonly PromptPath[] {
  return secret === 'injection' || secret === 'third_party' ? MEMORY_PATHS : PROMPT_PATHS;
}

export function scoreTimeline(input: ScoreInput): TimelineScore {
  const { timeline, horizon, contexts, store } = input;
  const score: TimelineScore = {
    leaks: [],
    stale: [],
    contradictions: [],
    recallMisses: [],
    recall: { hit: 0, expected: 0 },
    erasure: { held: 0, expected: 0 },
    exportMisses: [],
    vacuous: [],
  };
  const finding = (text: string, where: string, secret?: SecretClass): Finding => ({
    timeline: timeline.id,
    horizon,
    text,
    where,
    ...(secret ? { secret } : {}),
  });
  const primary = JSON.stringify(input.primaryExport);
  const exportFacts = input.primaryExport.facts;

  if (input.primaryExport.facts.length !== input.storeCounts.facts) {
    score.exportMisses.push(finding(`facts ${input.storeCounts.facts}`, 'export'));
  }
  if (input.primaryExport.episodes.length !== input.storeCounts.episodes) {
    score.exportMisses.push(finding(`episodes ${input.storeCounts.episodes}`, 'export'));
  }

  for (const probe of timeline.probes) {
    if (!probe.at.includes(horizon)) continue;
    switch (probe.kind) {
      case 'current': {
        for (const path of probe.reach) {
          score.recall.expected += 1;
          if (has(contexts[path], probe.text)) score.recall.hit += 1;
          else score.recallMisses.push(finding(probe.text, path));
        }
        if (probe.reach.includes('coach') && !has(primary, probe.text)) {
          score.exportMisses.push(finding(probe.text, 'export'));
        }
        break;
      }
      case 'stale': {
        if (!has(store, probe.text)) {
          score.vacuous.push(finding(probe.text, 'store'));
          break;
        }
        for (const path of MEMORY_PATHS) {
          if (has(contexts[path], probe.text)) score.stale.push(finding(probe.text, path));
        }
        // The export is the full history: a replaced value is there, marked replaced.
        const row = exportFacts.find((fact) => has(JSON.stringify(fact.value), probe.text));
        if (!row || (row.invalidatedAt === null && row.expiresAt === null)) {
          score.exportMisses.push(finding(probe.text, 'export'));
        }
        break;
      }
      case 'correction': {
        for (const path of PROMPT_PATHS) {
          if (has(contexts[path], probe.was) && has(contexts[path], probe.now)) {
            score.contradictions.push(finding(`${probe.was} | ${probe.now}`, path));
          }
        }
        break;
      }
      case 'secret': {
        if (!has(store, probe.text)) {
          score.vacuous.push(finding(probe.text, 'store', probe.secret));
          break;
        }
        const erasable = probe.secret === 'forgotten' || probe.secret === 'deleted';
        if (erasable) score.erasure.expected += 1;
        let held = true;
        for (const path of pathsFor(probe.secret)) {
          if (has(contexts[path], probe.text)) {
            held = false;
            score.leaks.push(finding(probe.text, path, probe.secret));
          }
        }
        if (erasable && held) score.erasure.held += 1;
        if (probe.secret === 'teen' || probe.secret === 'deleted') {
          if (has(primary, probe.text))
            score.leaks.push(finding(probe.text, 'export', probe.secret));
        }
        if (probe.secret === 'forgotten') {
          // Forgetting retires the belief; the right-to-access copy still shows it, closed.
          const row = exportFacts.find((fact) => has(JSON.stringify(fact.value), probe.text));
          if (!row || row.invalidatedAt === null) {
            score.exportMisses.push(finding(probe.text, 'export'));
          }
        }
        break;
      }
      case 'coparentExport': {
        const copy = input.coParentExport;
        if (!copy) {
          score.exportMisses.push(finding(probe.text, 'export.coparent'));
          break;
        }
        const words = JSON.stringify(copy);
        if (probe.shared && !has(words, probe.text)) {
          score.exportMisses.push(finding(probe.text, 'export.coparent'));
        }
        if (!probe.shared) {
          if (!has(store, probe.text)) score.vacuous.push(finding(probe.text, 'store'));
          else if (has(words, probe.text)) {
            score.leaks.push(finding(probe.text, 'export.coparent'));
          } else if (!copy.facts.some((fact) => fact.withheld === 'source_not_recorded')) {
            // The row must still be listed, dated and typed, with why its words are not.
            score.exportMisses.push(finding(probe.text, 'export.coparent'));
          }
        }
        break;
      }
    }
  }
  return score;
}

/** The gate's totals across every timeline and horizon. */
export function totalScores(scores: readonly TimelineScore[]) {
  const sum = (pick: (score: TimelineScore) => number) =>
    scores.reduce((total, score) => total + pick(score), 0);
  return {
    runs: scores.length,
    leaks: sum((s) => s.leaks.length),
    stale: sum((s) => s.stale.length),
    contradictions: sum((s) => s.contradictions.length),
    recallHit: sum((s) => s.recall.hit),
    recallExpected: sum((s) => s.recall.expected),
    erasureHeld: sum((s) => s.erasure.held),
    erasureExpected: sum((s) => s.erasure.expected),
    exportMisses: sum((s) => s.exportMisses.length),
    vacuous: sum((s) => s.vacuous.length),
  };
}
