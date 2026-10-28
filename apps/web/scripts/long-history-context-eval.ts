// VIL-144: free long-history context eval. `tsx scripts/long-history-context-eval.ts [--broken]`
// Exits 1 when any case fails (so --broken must exit 1). No keys, no model calls.
import { runLongHistoryEval } from '../lib/coach/long-history-eval';

const results = runLongHistoryEval({ broken: process.argv.includes('--broken') });
console.table(results);
process.exit(results.every((r) => r.pass) ? 0 : 1);
