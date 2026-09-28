/**
 * VIL-378 — signup-open watch.
 *
 * Mirrors the municipal registration morning: arm fifteen minutes before the
 * organizer's own site opens, then read that URL at open and again two minutes
 * later. This module does not compose a parent-facing message. Design owns the
 * words. The row's watch_status is the job; an optional port can also enqueue
 * the three wakes onto a queue.
 */

export const ARM_LEAD_MS = 15 * 60 * 1000;
export const FIRE_GRACE_MS = 2 * 60 * 1000;

const SOLD_OUT = /sold out|fully booked|registration (?:is )?closed|no longer available/i;

export type SignupPhase = 'arm' | 'fire' | 'follow_up';
export type SignupWatchStatus = 'scheduled' | 'armed' | 'fired' | 'filled' | 'missed';

export interface SignupJob {
  phase: SignupPhase;
  startAfter: Date;
}

export interface SignupJobPort {
  send(job: {
    spotId: string;
    phase: SignupPhase;
    startAfter: Date;
    registrationUrl: string;
  }): Promise<void>;
}

export interface SignupWatchRow {
  id: string;
  registrationOpensAt: Date;
  registrationUrl: string;
  watchStatus: 'scheduled' | 'armed';
}

export interface SignupWatchPatch {
  watchStatus: SignupWatchStatus;
  nextWakeAt: Date | null;
}

export interface SignupWatchStore {
  due(now: Date): Promise<SignupWatchRow[]>;
  save(id: string, patch: SignupWatchPatch): Promise<void>;
}

export type PageRead = 'open' | 'filled' | 'unreadable';

export function signupWatchJobs(opensAt: Date): SignupJob[] {
  return [
    { phase: 'arm', startAfter: new Date(opensAt.getTime() - ARM_LEAD_MS) },
    { phase: 'fire', startAfter: opensAt },
    { phase: 'follow_up', startAfter: new Date(opensAt.getTime() + FIRE_GRACE_MS) },
  ];
}

export function signupPhase(now: Date, opensAt: Date): 'wait' | 'arm' | 'fire' | 'missed' {
  const t = now.getTime();
  if (t < opensAt.getTime() - ARM_LEAD_MS) return 'wait';
  if (t < opensAt.getTime()) return 'arm';
  if (t <= opensAt.getTime() + FIRE_GRACE_MS) return 'fire';
  return 'missed';
}

export function readRegistrationPage(html: string, ok: boolean): PageRead {
  if (!ok) return 'unreadable';
  if (SOLD_OUT.test(html)) return 'filled';
  return 'open';
}

export async function enqueueSignupWatch(
  spot: { id: string; registrationOpensAt: Date | null; registrationUrl: string | null },
  port: SignupJobPort | null,
): Promise<
  | { status: 'skipped'; skipped: 'no_registration_clock' }
  | { status: 'enqueued'; jobs: SignupJob[] }
  | {
      status: 'scheduled';
      jobs: SignupJob[];
      skipped: 'queue_not_configured' | 'queue_unavailable';
    }
> {
  if (!spot.registrationOpensAt || !spot.registrationUrl) {
    return { status: 'skipped', skipped: 'no_registration_clock' };
  }
  const jobs = signupWatchJobs(spot.registrationOpensAt);
  if (!port) return { status: 'scheduled', jobs, skipped: 'queue_not_configured' };
  try {
    for (const job of jobs) {
      await port.send({
        spotId: spot.id,
        phase: job.phase,
        startAfter: job.startAfter,
        registrationUrl: spot.registrationUrl,
      });
    }
    return { status: 'enqueued', jobs };
  } catch {
    return { status: 'scheduled', jobs, skipped: 'queue_unavailable' };
  }
}

export interface SignupTickResult {
  id: string;
  watchStatus: SignupWatchStatus;
  page: PageRead | null;
}

/**
 * One tick of every watch that is due. A fire inside the two-minute window
 * reads the organizer's page. A watch still open after that window is missed.
 */
export async function runSignupWatchTick(
  now: Date,
  store: SignupWatchStore,
  fetchPage: (url: string) => Promise<{ ok: boolean; html: string }>,
): Promise<{ checked: number; results: SignupTickResult[] }> {
  const due = await store.due(now);
  const results: SignupTickResult[] = [];
  for (const row of due) {
    const phase = signupPhase(now, row.registrationOpensAt);
    if (phase === 'wait') continue;
    if (phase === 'arm') {
      await store.save(row.id, { watchStatus: 'armed', nextWakeAt: row.registrationOpensAt });
      results.push({ id: row.id, watchStatus: 'armed', page: null });
      continue;
    }
    if (phase === 'missed') {
      await store.save(row.id, { watchStatus: 'missed', nextWakeAt: null });
      results.push({ id: row.id, watchStatus: 'missed', page: null });
      continue;
    }
    let page: PageRead = 'unreadable';
    try {
      const response = await fetchPage(row.registrationUrl);
      page = readRegistrationPage(response.html, response.ok);
    } catch {
      page = 'unreadable';
    }
    if (page === 'unreadable') {
      await store.save(row.id, {
        watchStatus: 'armed',
        nextWakeAt: new Date(now.getTime() + 60_000),
      });
      results.push({ id: row.id, watchStatus: 'armed', page });
      continue;
    }
    const watchStatus = page === 'filled' ? 'filled' : 'fired';
    await store.save(row.id, { watchStatus, nextWakeAt: null });
    results.push({ id: row.id, watchStatus, page });
  }
  return { checked: due.length, results };
}
