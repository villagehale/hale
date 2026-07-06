import { NextResponse } from 'next/server';
import {
  type CompleteOnboardingInput,
  completeOnboarding,
} from '~/lib/onboarding/complete-onboarding';

export const runtime = 'nodejs';

/**
 * POST /api/mobile/onboarding — the native counterpart to the web onboarding
 * wizard's completeOnboarding server action. A signed-in mobile user (Google
 * immediately, or email once verified) posts the collected intake — children,
 * coarse location, intents, plan tier, TOS acceptance, parent name.
 *
 * auth() resolves from the Bearer bridge, and the SHARED completeOnboarding owns
 * the security-critical work: the 4 signup consents, the Canada region gate, and
 * the one atomic child-PII transaction (rule #1). This route is a thin HTTP mapper
 * that never touches the DB directly. no session → 401, non-Canada region → 422,
 * invalid input → 400.
 */
export async function POST(req: Request): Promise<Response> {
  const input = (await req.json().catch(() => null)) as CompleteOnboardingInput | null;
  if (!input || !Array.isArray(input.children)) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }

  const result = await completeOnboarding(input);
  switch (result.status) {
    case 'completed':
      return NextResponse.json({ status: 'completed', familyId: result.familyId });
    case 'region_unavailable':
      return NextResponse.json({ error: 'region_unavailable' }, { status: 422 });
    case 'invalid':
      return NextResponse.json({ error: result.error }, { status: 400 });
    default:
      // 'preview' — no DB (dev) or no resolved session (unauthenticated on mobile).
      return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }
}
