import { api } from './api-client';
import type {
  CreatePlanRequest,
  MobilePlanUpdateResponse,
} from './api-types';

/**
 * The native Plan write calls. Each POSTs the mobile plan route that delegates to
 * the SAME web server action the browser uses (createPlan / completePlan /
 * deletePlan) — the app never re-implements validation or the audit write; it posts
 * the intent. The shared api() client attaches the Bearer token, surfaces the
 * route's `error` on a non-2xx, and bounces to sign-in on 401.
 */

export async function createPlan(body: CreatePlanRequest): Promise<void> {
  await api<MobilePlanUpdateResponse>('/api/mobile/plan', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function completePlan(planId: string): Promise<void> {
  await api<MobilePlanUpdateResponse>('/api/mobile/plan', {
    method: 'POST',
    body: JSON.stringify({ action: 'complete', planId }),
  });
}

export async function deletePlan(planId: string): Promise<void> {
  await api<MobilePlanUpdateResponse>('/api/mobile/plan', {
    method: 'POST',
    body: JSON.stringify({ action: 'delete', planId }),
  });
}
