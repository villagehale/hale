import { schema } from '@hale/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '~/lib/db';

// The marketing site posts here cross-origin. Only Hale's own origins get CORS;
// anything else is a plain server-to-server post (no browser access to the
// response). Localhost covers the site's dev server.
const ALLOWED_ORIGINS = new Set([
  process.env.NEXT_PUBLIC_MARKETING_URL ?? 'https://villagehale.com',
  'https://villagehale.com',
  'https://www.villagehale.com',
]);

function corsHeaders(origin: string | null): HeadersInit {
  const allowed =
    origin !== null && (ALLOWED_ORIGINS.has(origin) || origin.startsWith('http://localhost'));
  if (!allowed) return { Vary: 'Origin' };
  return {
    'Access-Control-Allow-Origin': origin as string,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    Vary: 'Origin',
  };
}

const bodySchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  neighbourhood: z.string().trim().max(120).optional(),
  tier: z.enum(['plus', 'family']).optional(),
  // Honeypot — the form hides this field, so a value marks a bot.
  website: z.string().optional(),
});

export function OPTIONS(req: Request) {
  return new Response(null, { status: 204, headers: corsHeaders(req.headers.get('origin')) });
}

/**
 * POST /api/waitlist — the landing page's Plus/Family waitlist capture
 * (email + coarse neighbourhood + tier). Unauthenticated by design: the whole
 * point is capturing people who don't have accounts yet.
 *
 * The response is 202 {ok:true} for every well-formed submission — including
 * duplicates (unique email, `on conflict do nothing`) and honeypot hits — so
 * neither a bot nor a curious visitor can probe who is already on the list.
 */
export async function POST(req: Request) {
  const headers = corsHeaders(req.headers.get('origin'));

  let body: unknown = {};
  if (req.headers.get('content-type')?.includes('application/json')) {
    body = await req.json().catch(() => ({}));
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400, headers });
  }

  if (parsed.data.website) {
    return NextResponse.json({ ok: true }, { status: 202, headers });
  }

  await db()
    .insert(schema.waitlist)
    .values({
      email: parsed.data.email,
      neighbourhood: parsed.data.neighbourhood || null,
      tier: parsed.data.tier ?? null,
      source: 'landing_pricing',
    })
    .onConflictDoNothing();

  return NextResponse.json({ ok: true }, { status: 202, headers });
}
