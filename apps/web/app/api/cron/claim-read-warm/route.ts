import { NextResponse } from 'next/server';
import { runClaimReadProbe, runClaimReadWarm } from '~/lib/channel/reconcile/claim-read-probe';
import { defaultClaimReader } from '~/lib/channel/reconcile/claim-reader';
import { claimReaderMode } from '~/lib/channel/reconcile/flag';
import { cronRoute } from '~/lib/cron/auth';

// Node runtime: the Anthropic SDK and Intl.Segmenter with full ICU.
export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * GET /api/cron/claim-read-warm — VIL-581. Synthetic reads only: no family data, no send.
 *
 *  - `?mode=probe`: eight synthetic cases (a false booking and a true-row control in
 *    en, fr, zh and es) through the production reader and verifier. It ignores
 *    CLAIM_READER_MODE, so a deploy is proven before the flag moves. Run by
 *    scripts/probe-claim-reader.mts.
 *  - anything else: the warm, which compiles the output grammar on both lanes; skipped
 *    while CLAIM_READER_MODE is off.
 *
 * Not in vercel.json yet: PR 2 adds the schedule with the shadow reader. Always 200 with
 * the result in the body (`ok: false` names a wrong verdict). Cron-secret gated.
 */
export const GET = cronRoute('claim-read-warm', async (req) => {
  if (new URL(req.url).searchParams.get('mode') === 'probe') {
    return NextResponse.json(await runClaimReadProbe({ reader: defaultClaimReader('adaptive') }));
  }
  const result = await runClaimReadWarm({
    readers: { adaptive: defaultClaimReader('adaptive'), off: defaultClaimReader('off') },
    mode: claimReaderMode(),
  });
  return NextResponse.json(result);
});
