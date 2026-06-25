/**
 * Immediate drain kick (recipe #3). After a producer enqueues a hot-queue job
 * (accept → events.ingested, approve → actions.approved), fire the drain right
 * away inside Next's after() so the common case doesn't wait up to 60s for the
 * next cron tick. The every-minute drain cron stays the safety-net reaper for
 * anything this kick misses (cold start, transient failure).
 *
 * Implemented as an internal authenticated GET to the SAME cron-secret-gated
 * /api/cron/drain route — no duplicate drain logic, no second pg-boss wiring.
 * Best-effort: a kick failure is swallowed (logged), never surfaced to the user
 * — the job is already durably enqueued and the cron will drain it regardless.
 *
 * No CRON_SECRET configured → no kick (the drain route would 401 anyway); the
 * job still drains on the next cron tick.
 */
export function kickDrain(origin: string): void {
  const secret = process.env.CRON_SECRET;
  if (!secret) return;

  void fetch(new URL('/api/cron/drain', origin), {
    headers: { authorization: `Bearer ${secret}` },
  }).catch((err) => {
    console.error({ err }, 'kick-drain: failed to trigger drain (cron will reap)');
  });
}
