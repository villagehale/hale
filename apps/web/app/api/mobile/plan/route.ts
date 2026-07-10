import { NextResponse } from 'next/server';
import { scopeChildren } from '~/components/hale/child-scope-core';
import { auth } from '~/auth';
import { loadCompanion } from '~/lib/companion/queries';
import { loadFamilyTimezone } from '~/lib/dashboard/queries';
import { loadAuthoredPlans } from '~/lib/plan/authored';
import { completePlan, createPlan, deletePlan } from '~/lib/plan/plan-actions';
import { planChildItems } from '~/lib/plan/week';
import { loadVillage } from '~/lib/village/queries';
import type { MobilePlanResponse, MobilePlanUpdateRequest, MobilePlanUpdateResponse } from '../types';

export const runtime = 'nodejs';

/**
 * GET /api/mobile/plan — the native Plan ("your week") tab. Returns the SAME
 * server-side projection the web plan page computes: the parent-authored plans + the
 * family's IANA zone (so the client folds them into the same Mon–Sun spine), the
 * accepted non-teen activities added to the week, the latest routine, and the
 * forward-looking per-child items (planChildItems). Teen-attributed candidates are
 * filtered here exactly as the page does; loadVillage / loadAuthoredPlans already
 * apply teen policy (rule #1). Every loader is session-scoped and owns its own DB, so
 * this route never touches it. Auth() is the 401 gate.
 */
export async function GET(): Promise<Response> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const [village, children, authoredPlans, timeZone] = await Promise.all([
    loadVillage(),
    loadCompanion(),
    loadAuthoredPlans(),
    loadFamilyTimezone(),
  ]);
  const addedActivities = village.candidates.filter((c) => c.accepted && !c.teenAttributed);
  const childItems = planChildItems(children);
  const hasRoutine = (village.routine?.items.length ?? 0) > 0;
  const hasPlan =
    hasRoutine ||
    childItems.length > 0 ||
    addedActivities.length > 0 ||
    authoredPlans.length > 0;

  const body: MobilePlanResponse = {
    authoredPlans,
    timeZone,
    scopeChildren: scopeChildren(children),
    addedActivities,
    routine: village.routine,
    childItems,
    hasPlan,
  };
  return NextResponse.json(body);
}

/**
 * POST /api/mobile/plan — the native Plan page's parent-authored writes: create a
 * private plan, mark one done, or delete one. Each `action` delegates to the EXACT
 * server action the web Plan page calls (createPlan / completePlan / deletePlan), so
 * the shared lib owns validation, the family-scoping that keeps a caller inside their
 * own household (rule #1), and the immutable audit_log write (rule #6). This route
 * never touches the DB itself — it only dispatches. Auth() is the 401 gate; the
 * action's own preview / not_found / invalid outcomes map to statuses.
 */
export async function POST(req: Request): Promise<Response> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as MobilePlanUpdateRequest | null;
  if (!body || typeof body.action !== 'string' || !isWellTypedBody(body)) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }

  const result = await dispatch(body);

  switch (result.status) {
    case 'created':
    case 'completed':
    case 'deleted':
      return NextResponse.json({ status: result.status } satisfies MobilePlanUpdateResponse);
    case 'preview':
      return NextResponse.json({ error: 'preview' }, { status: 503 });
    case 'not_found':
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    default:
      return NextResponse.json({ error: result.error }, { status: 400 });
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Guards the payload field types before dispatch, so untrusted JSON can never reach
 * a reused server action in a shape that throws a bare 500. `create` fields flow into
 * validatePlan (`title.trim()`), so they must be typed. `complete`/`delete` carry a
 * planId that reaches a `uuid` column — an empty or non-UUID string throws on the cast
 * (not a clean no-match), so it must be a well-formed UUID here (a valid-but-unknown id
 * is left to the action's not_found → 404).
 */
function isWellTypedBody(body: MobilePlanUpdateRequest): boolean {
  if (body.action === 'create') {
    return (
      typeof body.title === 'string' &&
      (body.notes === null || typeof body.notes === 'string') &&
      (body.scheduledFor === null || typeof body.scheduledFor === 'string') &&
      (body.childId === null || typeof body.childId === 'string')
    );
  }
  if (body.action === 'complete' || body.action === 'delete') {
    return typeof body.planId === 'string' && UUID_RE.test(body.planId);
  }
  return true;
}

type DispatchResult =
  | { status: 'created' }
  | { status: 'completed' }
  | { status: 'deleted' }
  | { status: 'preview' }
  | { status: 'not_found' }
  | { status: 'invalid'; error: string };

async function dispatch(body: MobilePlanUpdateRequest): Promise<DispatchResult> {
  switch (body.action) {
    case 'create': {
      const result = await createPlan({
        title: body.title,
        notes: body.notes,
        scheduledFor: body.scheduledFor,
        childId: body.childId,
      });
      if (result.status === 'invalid') {
        return { status: 'invalid', error: result.error };
      }
      if (result.status === 'foreign_child') {
        return { status: 'invalid', error: 'foreign_child' };
      }
      return result;
    }
    case 'complete':
      return completePlan(body.planId);
    case 'delete':
      return deletePlan(body.planId);
    default:
      return { status: 'invalid', error: 'unknown_action' };
  }
}
