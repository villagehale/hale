import { NextResponse } from 'next/server';
import { runProdTextGate } from '~/lib/channel/canary/prod-gate';
import { cronRoute } from '~/lib/cron/auth';
import { db } from '~/lib/db';

// Node runtime: signs with node:crypto and reads Postgres. Not on the vercel.json
// schedule — a cron fire would hit the aliased deployment, which is the build
// already serving parents. GitHub calls this on the candidate URL instead.
export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * GET /api/cron/prod-text-gate — one probe turn on THIS deployment (VIL-696).
 *
 * Cron auth, then the gate. The JSON names a stage and nothing else: no phone,
 * no body, no secret. `ok: true` only when this deployment's drain wrote the
 * canary answer. The GitHub checker turns any other stage into a failed commit
 * status, which is what keeps the production domains on the previous build.
 */
export const GET = cronRoute('prod-text-gate', async (req: Request) => {
  const result = await runProdTextGate({
    database: db(),
    fetch,
    now: () => new Date(),
    origin: new URL(req.url).origin,
    deploymentId: process.env.VERCEL_DEPLOYMENT_ID ?? '',
  });
  return NextResponse.json(result);
});
