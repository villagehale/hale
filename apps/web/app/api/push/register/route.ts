import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '~/auth';
import { db } from '~/lib/db';
import { resolveUserIdForUser } from '~/lib/family';

// Node runtime: the route writes through Drizzle/pg, which doesn't run on the edge.
export const runtime = 'nodejs';

// An Expo token is either the ExponentPushToken[...] / ExpoPushToken[...] form or a
// FCM/APNs-shaped opaque string. We bound the length and shape rather than accept
// anything, so a stray body can't seed a garbage row.
const EXPO_TOKEN_RE = /^(ExponentPushToken|ExpoPushToken)\[[^\]]+\]$/;

const tokenSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .refine((t) => EXPO_TOKEN_RE.test(t), 'not a plausible Expo push token');

const bodySchema = z.object({
  expoPushToken: tokenSchema,
  platform: z.enum(['ios', 'android']).optional(),
});

const deleteBodySchema = z.object({ expoPushToken: tokenSchema });

/**
 * POST /api/push/register — a signed-in device registering its Expo push token.
 *
 * Auth() is the gate (401 signed-out). We resolve the internal users.id from the
 * session's external id (the same chain every route uses) and upsert on the unique
 * token, so a device that re-registers (reinstall / account switch) re-points its
 * token to the current user and bumps last_seen_at instead of duplicating rows.
 *
 * This is a device→user binding, not a user-facing action, so it produces NO
 * audit_log row (rule #6 is scoped to actions). It MUST stay auth-gated, and the
 * token value is never logged (rule #1).
 */
export async function POST(req: Request): Promise<Response> {
  const session = await auth();
  const externalAuthId = session?.user?.id;
  if (!externalAuthId) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_token' }, { status: 400 });
  }

  const database = db();
  const userId = await resolveUserIdForUser(externalAuthId, database);
  if (!userId) {
    return NextResponse.json({ error: 'no_user_for_caller' }, { status: 403 });
  }

  const now = new Date();
  await database
    .insert(schema.pushTokens)
    .values({
      userId,
      expoPushToken: parsed.data.expoPushToken,
      platform: parsed.data.platform ?? null,
      lastSeenAt: now,
    })
    .onConflictDoUpdate({
      target: schema.pushTokens.expoPushToken,
      set: { userId, platform: parsed.data.platform ?? null, lastSeenAt: now },
    });

  return NextResponse.json({ ok: true });
}

/**
 * DELETE /api/push/register — sign-out hygiene. The device removes its own token
 * binding so this account stops receiving pushes on a phone it just signed out of. The
 * delete is scoped to (token AND the resolved user), so a caller can only drop a token
 * bound to itself — a token re-pointed to another account (device handed over) is left
 * for that account's own upsert/sign-out. Auth() is the gate; the token value is never
 * logged (rule #1); no audit row (a device→user unbinding, not a user-facing action).
 */
export async function DELETE(req: Request): Promise<Response> {
  const session = await auth();
  const externalAuthId = session?.user?.id;
  if (!externalAuthId) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const parsed = deleteBodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_token' }, { status: 400 });
  }

  const database = db();
  const userId = await resolveUserIdForUser(externalAuthId, database);
  if (!userId) {
    return NextResponse.json({ error: 'no_user_for_caller' }, { status: 403 });
  }

  await database
    .delete(schema.pushTokens)
    .where(
      and(
        eq(schema.pushTokens.expoPushToken, parsed.data.expoPushToken),
        eq(schema.pushTokens.userId, userId),
      ),
    );

  return NextResponse.json({ ok: true });
}
