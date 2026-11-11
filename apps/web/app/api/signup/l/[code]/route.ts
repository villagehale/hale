import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '~/lib/db';
import { providerCredentialsEnabled } from '~/lib/signup/credentials/flag';
import { saveProviderCredentials } from '~/lib/signup/credentials/store';
import { consumeLoginLink, lookupLoginLink } from '~/lib/signup/login-link/store';
import { writePlanAudit } from '~/lib/signup/plan/store';

export const runtime = 'nodejs';

const bodySchema = z.object({
  username: z.string().trim().min(1).max(200),
  password: z.string().min(1).max(200),
  totpSeed: z.string().max(200).nullable().optional(),
});

/**
 * POST /api/signup/l/:code — save encrypted city credentials from the parent
 * page. The raw code is the auth: no Hale session. A successful save consumes
 * the link. Never logs the body.
 */
export async function POST(
  req: Request,
  context: { params: Promise<{ code: string }> },
): Promise<Response> {
  if (!providerCredentialsEnabled()) {
    return NextResponse.json({ error: 'gone' }, { status: 404 });
  }
  const { code } = await context.params;
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }
  const now = new Date();
  const looked = await lookupLoginLink(db(), code, now);
  if (!looked.ok) {
    return NextResponse.json({ error: 'gone' }, { status: 404 });
  }
  const saved = await saveProviderCredentials(db(), {
    familyId: looked.familyId,
    parentUserId: looked.parentUserId,
    providerHost: looked.providerHost,
    username: parsed.data.username,
    password: parsed.data.password,
    totpSeed: parsed.data.totpSeed ?? null,
    now,
  });
  if (!saved.ok) {
    return NextResponse.json({ error: saved.reason }, { status: 400 });
  }
  await consumeLoginLink(db(), { id: looked.id, now });
  if (looked.offerId) {
    const offers = schema.authorizedSignupOffers;
    const [offer] = await db()
      .select({ availability: offers.planAvailability })
      .from(offers)
      .where(and(eq(offers.id, looked.offerId), eq(offers.familyId, looked.familyId)))
      .limit(1);
    const kind =
      offer?.availability && typeof offer.availability.kind === 'string'
        ? offer.availability.kind
        : null;
    if (kind === 'password_rejected') {
      await db()
        .update(offers)
        .set({ planAvailability: null, planAvailabilityAt: null, updatedAt: now })
        .where(and(eq(offers.id, looked.offerId), eq(offers.familyId, looked.familyId)));
    }
    await writePlanAudit(db(), {
      familyId: looked.familyId,
      actor: looked.parentUserId,
      offerId: looked.offerId,
      after: { step: 'login_saved', host: looked.providerHost },
    });
  }
  return NextResponse.json({ saved: true, host: looked.providerHost });
}
