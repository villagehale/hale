import { NextResponse } from 'next/server';
import { captureServerEvent } from '~/lib/analytics/server-capture';
import { db } from '~/lib/db';
import { loadPublicParty, submitRsvp } from '~/lib/party/store';
import type { RsvpResponse } from '~/lib/party/tally';
import { clientIp, enforceRateLimit } from '~/lib/rate-limit/apply';

/**
 * POST /api/rsvp/:token — VIL-245 · M10. The ONE endpoint in Hale a stranger can write
 * to with no account, so every guard it has is stated here.
 *
 *   AUTHORIZATION is the token and nothing else. There is no session, and there is
 *     deliberately no way to make one: an account-less RSVP that asked for an account
 *     would not be an account-less RSVP. A wrong token is a 404 identical to a party
 *     that never existed, so the token space cannot be probed.
 *   THE BODY IS BOUNDED before it is read — a public write with an unbounded JSON body
 *     is an easy way to make a database do work on someone else's behalf.
 *   RATE LIMITED per IP, fail-closed. A guest list stuffed with junk names is the
 *     abuse this endpoint invites, and the limiter is the only thing standing there.
 *   NOTHING IS RETURNED about the party's other guests. The response says what happened
 *     to THIS submission and no more (the guest list is the host's).
 *
 * Runs on the Node runtime: the write path reaches node:crypto (AES-GCM + the blind
 * index) for the reminder opt-in.
 */
export const runtime = 'nodejs';

/** A generous ceiling on a form whose largest field is a name. */
const MAX_BODY_BYTES = 2_000;

const RESPONSES: readonly RsvpResponse[] = ['yes', 'no', 'maybe'];

function isResponse(value: unknown): value is RsvpResponse {
  return typeof value === 'string' && (RESPONSES as readonly string[]).includes(value);
}

export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const limited = await enforceRateLimit('rsvp', clientIp(req), true);
  if (limited) return limited;

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'too_large' }, { status: 413 });
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'malformed' }, { status: 400 });
  }

  const { token } = await ctx.params;
  const party = await loadPublicParty(db(), token);
  // Indistinguishable from a token that never existed.
  if (!party) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  if (!isResponse(payload.response)) {
    return NextResponse.json({ error: 'invalid', field: 'response' }, { status: 400 });
  }

  const result = await submitRsvp(
    db(),
    { inviteId: party.inviteId, familyId: party.familyId, cancelled: party.cancelled },
    {
      displayName: typeof payload.displayName === 'string' ? payload.displayName : '',
      response: payload.response,
      headcount: typeof payload.headcount === 'number' ? payload.headcount : 1,
      reminderPhone: typeof payload.reminderPhone === 'string' ? payload.reminderPhone : null,
    },
  );

  if (result.status === 'invalid') {
    return NextResponse.json({ error: 'invalid', field: result.field }, { status: 400 });
  }
  if (result.status === 'cancelled') {
    return NextResponse.json({ error: 'cancelled' }, { status: 409 });
  }

  // Coarse only, and the distinct id is the INVITE — a guest is not a person Hale gets
  // to identify. `buildEvent` drops anything identifying regardless (rule #1).
  await captureServerEvent('rsvp_submitted', party.inviteId, {
    answer: payload.response,
    reminderOptIn: result.reminderOptIn,
  });

  return NextResponse.json({ ok: true, reminderOptIn: result.reminderOptIn }, { status: 200 });
}
