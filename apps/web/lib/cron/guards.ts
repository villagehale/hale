import type { GuardDeps } from '@hale/agent';
import type { Database } from '@hale/db';
import { buildGuardDeps } from '~/lib/coach/guards';

/**
 * GuardDeps for the SCHEDULED (cron) agents. The safety rails are identical to
 * the interactive Concierge agent's — the harness runs them BEFORE any tool
 * handler, so a passive run can no more skip the cap / audit / teen-redaction
 * than a parent's question can:
 *
 *   writeAudit              → an immutable audit_log row per tool call (rule #6)
 *   checkSpendingCap        → per-action spending cap (rule #7)
 *   checkChildContentAccess → teen-redaction / consent at the tool boundary (rule #1/#5)
 *
 * We REUSE the coach's buildGuardDeps (the single source of the cap/teen/audit
 * implementations) verbatim — no second copy of the rule logic to drift. The
 * audit ACTOR is set per-run through the harness `toolContext` (a cron run uses
 * 'system', since there is no signed-in parent), not here.
 */
export function buildCronGuardDeps(database: Database): GuardDeps {
  return buildGuardDeps(database);
}
