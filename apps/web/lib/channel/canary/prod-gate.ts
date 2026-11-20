import { randomUUID } from 'node:crypto';
import { type Database, schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { INBOUND_TURN_QUEUES } from '~/lib/channel/config';
import { linqInboundConfigured, linqWebhookSecret } from '~/lib/channel/linq/config';
import { LINQ_WEBHOOK_VERSION, signLinqWebhook } from '~/lib/channel/linq/signature';
import { deploymentOrigin } from '~/lib/cron/kick-drain';
import {
  CANARY_ANSWERED_ACTION,
  CANARY_BODY,
  CANARY_CHAT_ID_PREFIX,
  CANARY_PHONE_E164,
  canaryChannel,
} from './config';
import { seedCanaryHousehold } from './seed';

/**
 * One text against the build that is not serving Production yet (VIL-696).
 *
 * Vercel holds the production domains until a GitHub commit status passes.
 * This posts one Linq-signed inbound at THIS deployment's own URL — the
 * synthetic probe number, never a parent's phone — then asks this same
 * deployment to drain. The reply is the canary audit row stamped with this
 * deployment's id. The handler sends nothing. No model call.
 *
 * A build still aliased to the domain does not stamp that id, so its minute
 * cron cannot pass the gate. When it wins the job anyway, the gate tries one
 * more turn and then fails closed.
 */

export const PROD_GATE_SID_PREFIX = 'hale-prod-gate-';

export const PROD_GATE_ATTEMPTS = 2;
export const PROD_GATE_INJECTION_TIMEOUT_MS = 15_000;
export const PROD_GATE_DRAIN_TIMEOUT_MS = 45_000;
export const PROD_GATE_POLL_INTERVAL_MS = 1_000;
export const PROD_GATE_POLL_BUDGET_MS = 20_000;

export type ProdTextGateStage =
  | 'not_configured'
  | 'household'
  | 'injection'
  | 'not_landed'
  | 'not_enqueued'
  | 'never_answered'
  | 'answered_elsewhere'
  | 'answered';

export interface ProdTextGateResult {
  ok: boolean;
  stage: ProdTextGateStage;
  attempts: number;
}

export interface ProdTextGateDeps {
  database: Database;
  fetch: typeof globalThis.fetch;
  now: () => Date;
  /** The deployment URL the checker called. Production must be this process's VERCEL_URL. */
  origin: string;
  deploymentId: string;
  env?: Readonly<Record<string, string | undefined>>;
  sleep?: (ms: number) => Promise<void>;
  timing?: {
    attempts?: number;
    injectionTimeoutMs?: number;
    drainTimeoutMs?: number;
    pollIntervalMs?: number;
    pollBudgetMs?: number;
  };
}

interface TurnEvidence {
  landed: boolean;
  enqueued: boolean;
  answered: boolean;
  deploymentId: string | null;
}

const EMPTY_TURN: TurnEvidence = {
  landed: false,
  enqueued: false,
  answered: false,
  deploymentId: null,
};

function deploymentIdFromAudit(after: unknown): string | null {
  if (!after || typeof after !== 'object') return null;
  const value = (after as { deploymentId?: unknown }).deploymentId;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** The far side of one gate turn: the inbound row, then the answer stamped on it. */
export async function readProdGateTurn(
  database: Database,
  providerMessageId: string,
): Promise<TurnEvidence> {
  const [message] = await database
    .select({
      id: schema.channelMessages.id,
      handedOffAt: schema.channelMessages.handedOffAt,
    })
    .from(schema.channelMessages)
    .where(eq(schema.channelMessages.providerMessageId, providerMessageId))
    .limit(1);
  if (!message) return EMPTY_TURN;

  const [answered] = await database
    .select({ after: schema.auditLog.after })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.actionTaken, CANARY_ANSWERED_ACTION),
        eq(schema.auditLog.targetTable, 'channel_messages'),
        eq(schema.auditLog.targetId, message.id),
      ),
    )
    .limit(1);

  return {
    landed: true,
    enqueued: message.handedOffAt !== null,
    answered: Boolean(answered),
    deploymentId: deploymentIdFromAudit(answered?.after),
  };
}

function bypassHeader(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const bypass = env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim();
  return bypass ? { 'x-vercel-protection-bypass': bypass } : {};
}

function candidateOriginOk(
  origin: string,
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  if (env.VERCEL_ENV !== 'production') return true;
  const own = deploymentOrigin(env);
  return own !== null && parsed.origin === own;
}

async function ensureHousehold(database: Database): Promise<'ready' | 'inactive'> {
  if (await canaryChannel(database)) return 'ready';
  const seeded = await seedCanaryHousehold(database);
  if (seeded.status === 'inactive') return 'inactive';
  return (await canaryChannel(database)) ? 'ready' : 'inactive';
}

function gatePayload(messageId: string, now: Date): string {
  return JSON.stringify({
    webhook_version: LINQ_WEBHOOK_VERSION,
    event_type: 'message.received',
    data: {
      id: messageId,
      direction: 'inbound',
      sent_at: now.toISOString(),
      sender_handle: { handle: CANARY_PHONE_E164, is_me: false },
      chat: { id: `${CANARY_CHAT_ID_PREFIX}${messageId}`, is_group: false },
      parts: [{ type: 'text', value: CANARY_BODY }],
    },
  });
}

async function postInbound(
  deps: ProdTextGateDeps,
  env: Readonly<Record<string, string | undefined>>,
  messageId: string,
  timeoutMs: number,
): Promise<'ok' | 'refused'> {
  const secret = linqWebhookSecret();
  if (!secret) return 'refused';
  const now = deps.now();
  const rawBody = gatePayload(messageId, now);
  const webhookId = `evt_${messageId}`;
  const timestamp = String(Math.floor(now.getTime() / 1000));
  const url = `${deps.origin}/api/channels/linq/inbound?version=${LINQ_WEBHOOK_VERSION}`;
  let response: Response;
  try {
    response = await deps.fetch(url, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'content-type': 'application/json',
        'webhook-id': webhookId,
        'webhook-timestamp': timestamp,
        'webhook-signature': signLinqWebhook({ secret, webhookId, timestamp, rawBody }),
        ...bypassHeader(env),
      },
      body: rawBody,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return 'refused';
  }
  if (response.status < 200 || response.status >= 300) return 'refused';
  return 'ok';
}

async function kickCandidateDrain(
  deps: ProdTextGateDeps,
  env: Readonly<Record<string, string | undefined>>,
  timeoutMs: number,
): Promise<void> {
  const secret = env.CRON_SECRET?.trim();
  if (!secret) return;
  const url = new URL('/api/cron/drain', deps.origin);
  url.searchParams.set('queues', INBOUND_TURN_QUEUES.join(','));
  try {
    await deps.fetch(url, {
      method: 'GET',
      redirect: 'manual',
      headers: {
        authorization: `Bearer ${secret}`,
        ...bypassHeader(env),
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    // The webhook's own after() kick is the other chance. The poll is the verdict.
  }
}

async function pollTurn(
  deps: ProdTextGateDeps,
  providerMessageId: string,
  budgetMs: number,
  intervalMs: number,
): Promise<TurnEvidence> {
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const deadline = deps.now().getTime() + budgetMs;
  let evidence = await readProdGateTurn(deps.database, providerMessageId);
  while (!evidence.answered && deps.now().getTime() < deadline) {
    await sleep(intervalMs);
    evidence = await readProdGateTurn(deps.database, providerMessageId);
  }
  return evidence;
}

function stageOf(evidence: TurnEvidence, deploymentId: string): ProdTextGateStage {
  if (!evidence.landed) return 'not_landed';
  if (!evidence.enqueued) return 'not_enqueued';
  if (!evidence.answered) return 'never_answered';
  if (evidence.deploymentId !== deploymentId) return 'answered_elsewhere';
  return 'answered';
}

/**
 * Fail closed on every stage but `answered`. Two attempts only when the
 * previous build answered the first turn; a broken door does not get a second.
 */
export async function runProdTextGate(deps: ProdTextGateDeps): Promise<ProdTextGateResult> {
  const env = deps.env ?? process.env;
  const deploymentId = deps.deploymentId.trim();
  const timing = deps.timing ?? {};
  const attempts = timing.attempts ?? PROD_GATE_ATTEMPTS;
  const injectionTimeoutMs = timing.injectionTimeoutMs ?? PROD_GATE_INJECTION_TIMEOUT_MS;
  const drainTimeoutMs = timing.drainTimeoutMs ?? PROD_GATE_DRAIN_TIMEOUT_MS;
  const pollIntervalMs = timing.pollIntervalMs ?? PROD_GATE_POLL_INTERVAL_MS;
  const pollBudgetMs = timing.pollBudgetMs ?? PROD_GATE_POLL_BUDGET_MS;

  if (!candidateOriginOk(deps.origin, env) || !deploymentId || !linqInboundConfigured()) {
    return { ok: false, stage: 'not_configured', attempts: 0 };
  }
  if (!env.CRON_SECRET?.trim()) {
    return { ok: false, stage: 'not_configured', attempts: 0 };
  }

  if ((await ensureHousehold(deps.database)) === 'inactive') {
    return { ok: false, stage: 'household', attempts: 0 };
  }

  let stage: ProdTextGateStage = 'never_answered';
  let used = 0;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    used = attempt;
    const messageId = `${PROD_GATE_SID_PREFIX}${randomUUID()}`;
    const posted = await postInbound(deps, env, messageId, injectionTimeoutMs);
    if (posted !== 'ok') return { ok: false, stage: 'injection', attempts: used };

    await kickCandidateDrain(deps, env, drainTimeoutMs);
    const evidence = await pollTurn(deps, messageId, pollBudgetMs, pollIntervalMs);
    stage = stageOf(evidence, deploymentId);
    if (stage === 'answered') return { ok: true, stage, attempts: used };
    if (stage !== 'answered_elsewhere') return { ok: false, stage, attempts: used };
  }

  return { ok: false, stage, attempts: used };
}
