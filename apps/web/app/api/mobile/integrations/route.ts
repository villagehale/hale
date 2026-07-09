import { NextResponse } from 'next/server';
import { loadConnectorsState } from '~/lib/integrations/load';
import { toConnectorStates } from '~/lib/integrations/mobile-view';
import type { MobileIntegrationsResponse } from '../types';

export const runtime = 'nodejs';

/**
 * GET /api/mobile/integrations — the native "Connected accounts" state: whether each
 * read-only Google connector (gcal/gmail/gdrive) is linked for the caller's family.
 * All DB access lives behind loadConnectorsState (the mobile route stays DB-free per
 * the rule-#1 tripwire); this route normalizes the raw status into an honest UI
 * status and serializes ONLY provider + status + a connect timestamp — never tokens
 * or scopes. A signed-in parent with no family reads as all-not-connected (fail
 * closed). Signed-out → 401; no DB (dev preview) → 503.
 */
export async function GET(): Promise<Response> {
  const result = await loadConnectorsState();
  switch (result.status) {
    case 'ready': {
      const body: MobileIntegrationsResponse = {
        connectors: toConnectorStates(result.connections),
      };
      return NextResponse.json(body);
    }
    case 'preview':
      return NextResponse.json({ error: 'preview' }, { status: 503 });
    default:
      return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }
}
