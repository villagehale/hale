import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AUDIT_VERBS } from './verbs';

/**
 * The drift guard between what the app WRITES and what the trail can SAY.
 *
 * `VERBS: Record<AuditVerb, Verb>` already makes a verb in the inventory with no
 * sentence a compile error. Nothing made the reverse true: a new audit write site
 * could ship without ever touching this directory, and its rows would render as the
 * NEUTRAL "recorded an update" — Hale describing its own work as an anonymous
 * update. That is how 83 verbs (every channel, intake, nudge, caregiver, intro,
 * document, party and registration write) came to be uncurated at once.
 *
 * So: scan the source for every audit write and require it to be curated.
 *
 * Every write goes through the `actionTaken` property (audit_log's verb column is
 * only ever set by name — verified: no raw `action_taken:` insert exists). A site is
 * either
 *   - DIRECT — `actionTaken: 'some_verb'` — collected and checked automatically, or
 *   - INDIRECT — a constant, ternary, or template — which cannot be read statically,
 *     so the file must be registered below WITH the concrete verbs it can write.
 *
 * An unregistered indirect site FAILS. That is the point: the only way to add an
 * audit write Hale cannot describe is to edit this file, which is where the author
 * is told to go write the sentence.
 */

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '../../../..');

/** Where audit rows are written from. apps/mobile writes none (it calls the web API). */
const SCAN_ROOTS = ['apps/web/lib', 'apps/web/app', 'apps/worker/src', 'packages'];

/**
 * Indirect write sites → the concrete verbs each can produce, expanded from the
 * closed enum/constant behind it. Keyed by path (not line) so ordinary edits do not
 * break the guard. Every verb listed here is checked against the inventory exactly
 * like a direct literal.
 */
const INDIRECT_WRITE_SITES: Record<string, readonly string[]> = {
  // `${auditAction}` / `${auditAction}.skipped_duplicate` over the five executor
  // constants (ROUTINE_PIN / DIGEST_NOTE / CALENDAR_PLACED / _MOVED / _CANCELLED).
  'apps/worker/src/services/internal-writes.ts': [
    'action.routine_pinned',
    'action.routine_pinned.skipped_duplicate',
    'action.digest_noted',
    'action.digest_noted.skipped_duplicate',
    'action.calendar_placed',
    'action.calendar_placed.skipped_duplicate',
    'action.calendar_moved',
    'action.calendar_moved.skipped_duplicate',
    'action.calendar_cancelled',
    'action.calendar_cancelled.skipped_duplicate',
  ],
  // `action.reviewer.${verdictColumn}`, the executed/failed ternary,
  // `action.gated.${ActionGateReason}`, `event.stage.${StageCheckpoint}`,
  // `event.dropped.${reason}` (written as shorthand from recordDrop).
  'apps/worker/src/services/memory-writer.ts': [
    'event.dropped.low_confidence',
    'event.dropped.unknown_action_type',
    'event.dropped.needs_human',
    'action.reviewer.approved',
    'action.reviewer.rejected',
    'action.reviewer.flagged',
    'action.executed',
    'action.execution_failed',
    'action.gated.observation_window',
    'action.gated.streak',
    'action.gated.cross_parent_consent',
    'action.gated.teen_redaction',
    'action.gated.over_allowance',
    'action.gated.autonomy_not_opted_in',
    'event.stage.classified',
    'event.stage.drafted',
    'event.stage.reviewed',
    'event.stage.approved_pending_execute',
    'event.stage.actioned',
    'event.stage.failed',
  ],
  // `action.reviewed.${verdict.kind}` + `action.gated.${reason}` (one caller,
  // ingest.ts, always 'observation_window').
  'apps/web/lib/pipeline/record.ts': [
    'action.reviewed.approve',
    'action.reviewed.reject',
    'action.reviewed.flag_for_human',
    'action.gated.observation_window',
  ],
  // ORIGIN_STAMPS — which interface asked for the draft.
  'apps/web/lib/coach/inline-action.ts': [
    'ask_hale.action_drafted',
    'mcp.action_drafted',
    'registration_sweep.action_drafted',
  ],
  // `quick_log_${episodeType}` over the log-types constants. booking_requested is
  // reachable only if the dead BOOKING_EPISODE constant is ever wired up.
  'apps/web/lib/companion/log-write.ts': [
    'quick_log_feed',
    'quick_log_nap',
    'quick_log_diaper',
    'quick_log_milestone',
    'quick_log_measurement',
    'quick_log_health_done',
    'quick_log_booking_requested',
  ],
  // closeInvite takes its verb as a POSITIONAL parameter and writes it as object
  // shorthand — the terminal states of a caregiver invite.
  'apps/web/lib/channel/caregiver/invites.ts': [
    'caregiver_invite_expired',
    'caregiver_invite_superseded',
    'caregiver_invite_superseded_by_join',
    'caregiver_invite_withdrawn',
    'caregiver_invite_refused',
  ],
  'apps/web/lib/channel/router/wiring.ts': ['smoke_alarm_fired'],
  // `REPLY_SENT_ACTION[carriedBy]` — one verb per door the router can answer
  // through (whatsapp audits under the phone verb), because the trail has to be able
  // to say WHICH one an answer went out of.
  'apps/web/lib/channel/router/route.ts': ['sms_reply_sent', 'email_reply_sent'],
  'apps/web/lib/channel/coach/draft.ts': ['channel_sms.calendar_drafted'],
  'apps/web/lib/channel/caregiver/route.ts': ['caregiver_sms_inbound', 'caregiver_sms_outbound'],
  'apps/web/lib/channel/join/route.ts': ['join_sms_inbound', 'join_sms_outbound'],
  'apps/web/lib/channel/intake/machine.ts': ['sms_intake_inbound', 'sms_intake_outbound'],
  'apps/web/lib/channel/intake/watch-consent.ts': [
    'proactive_watch_granted',
    'proactive_watch_declined',
  ],
  'apps/web/lib/integrations/store.ts': ['integration_connected', 'integration_revoked'],
  'apps/web/lib/village/intros/consent.ts': [
    'village_intro_discoverability_granted',
    'village_intro_discoverability_revoked',
  ],
  'apps/web/lib/village/intros/reply.ts': ['village_intro_accepted', 'village_intro_declined'],
  // Pass-throughs: they forward a caller's verb, so the literal is caught at the
  // caller and this file introduces no verb of its own.
  'apps/web/lib/coach/guards.ts': [],
  // `tool:<name>` — the Ask Hale agent's internal sub-steps. NEVER parent-facing:
  // trail-query.ts excludes them from both the timeline and the export before
  // trailVerb is ever called, which the test below re-checks rather than trusts.
  'packages/agent/src/tool.ts': [],
};

interface WriteSite {
  /** Verbs written as a plain string literal, verb → where it was found. */
  literals: Map<string, string>;
  /** Repo-relative paths whose verb is a constant/ternary/template. */
  indirect: Set<string>;
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.next') continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (/\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path)) out.push(path);
  }
  return out;
}

/** Collects every `actionTaken:` write across the scanned roots. */
function scanWriteSites(): WriteSite {
  const literals = new Map<string, string>();
  const indirect = new Set<string>();

  for (const root of SCAN_ROOTS) {
    for (const file of sourceFiles(join(REPO_ROOT, root))) {
      const relative = file.slice(REPO_ROOT.length + 1);
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, index) => {
          // Object shorthand (`actionTaken,`) — the verb arrived as a variable, most
          // often a positional helper parameter. Nothing to read statically, so the
          // file owes an enumeration exactly like any other indirect site. This form
          // hid four caregiver-invite verbs from an earlier version of this scanner.
          if (/^\s*actionTaken,\s*$/.test(line)) {
            indirect.add(relative);
            return;
          }
          const match = line.match(/actionTaken:\s*(.+?)(,|\s*\}|$)/);
          if (!match) return;
          const expression = (match[1] ?? '').trim().replace(/[,;]$/, '');
          // A type annotation, the column definition, or a READ that projects the
          // column (`actionTaken: schema.auditLog.actionTaken` in a select) — none of
          // them write a verb, and a reader registered as an indirect write site
          // would owe an enumeration of verbs it never produces.
          if (/^(string|AuditVerb|text\(|schema\.)/.test(expression)) return;
          const verb = expression.match(/^'([^']*)'$/)?.[1];
          if (verb === undefined) {
            indirect.add(relative);
          } else if (!literals.has(verb)) {
            literals.set(verb, `${relative}:${index + 1}`);
          }
        });
    }
  }
  return { literals, indirect };
}

describe('audit verb drift (rule #6 — the trail must be able to describe every write)', () => {
  const sites = scanWriteSites();
  const curated = new Set<string>(AUDIT_VERBS);

  it('finds the audit write sites at all — the scanner itself has not silently broken', () => {
    // A scanner that matches nothing would make every assertion below vacuously
    // pass. Pin it against known-present writes.
    expect(sites.literals.size).toBeGreaterThan(80);
    expect(sites.indirect.size).toBeGreaterThan(10);
    expect([...sites.literals.keys()]).toContain('family_created');
  });

  it('curates every verb written as a literal', () => {
    const missing = [...sites.literals.entries()]
      .filter(([verb]) => !curated.has(verb))
      .map(([verb, at]) => `${verb}  (written at ${at})`);

    expect(
      missing,
      `These audit verbs are written but missing from AUDIT_VERBS, so the trail renders them as "recorded an update". Add each to AUDIT_VERBS and give it an honest sentence in VERBS:\n${missing.join('\n')}`,
    ).toEqual([]);
  });

  it('registers every indirect write site, and curates the verbs it can produce', () => {
    const unregistered = [...sites.indirect].filter((file) => !(file in INDIRECT_WRITE_SITES));
    expect(
      unregistered,
      `These files write an audit verb from a constant, ternary or template, which cannot be read statically. Register each in INDIRECT_WRITE_SITES with the concrete verbs it can write:\n${unregistered.join('\n')}`,
    ).toEqual([]);

    const missing = Object.entries(INDIRECT_WRITE_SITES)
      .flatMap(([file, verbs]) => verbs.map((verb) => ({ file, verb })))
      .filter(({ verb }) => !curated.has(verb))
      .map(({ file, verb }) => `${verb}  (from ${file})`);
    expect(missing, `Uncurated verbs from indirect sites:\n${missing.join('\n')}`).toEqual([]);
  });

  it('keeps the registered indirect sites real — a stale entry is removed, not left to rot', () => {
    const stale = Object.keys(INDIRECT_WRITE_SITES).filter((file) => !sites.indirect.has(file));
    expect(
      stale,
      `These files are registered as indirect audit write sites but no longer write one. Remove them from INDIRECT_WRITE_SITES:\n${stale.join('\n')}`,
    ).toEqual([]);
  });

  it('keeps agent tool sub-steps out of the trail, which is why they need no sentence', () => {
    // packages/agent/src/tool.ts is registered with NO verbs on the grounds that its
    // `tool:<name>` rows never reach trailVerb. If that exclusion is ever dropped,
    // those rows would start rendering as "recorded an update" — so the claim is
    // checked here rather than believed.
    const trailQuery = readFileSync(
      join(REPO_ROOT, 'apps/web/lib/dashboard/trail-query.ts'),
      'utf8',
    );
    expect(trailQuery).toContain('notLike(schema.auditLog.actionTaken');
    expect(trailQuery).toContain('AGENT_TOOL_ACTION_PREFIX');
  });
});
