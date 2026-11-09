import { type DrainSummary, isConnectionExhaustion } from '~/lib/cron/drain';

/**
 * How many times a kicked run asks for a database before it leaves the turn to the
 * scheduled run.
 *
 * A kicked run starts the moment a parent's text lands, so a burst of texts is a burst of
 * runs all opening pg-boss at once against the pooler's 15 shared clients, and the ones
 * that lose die before their first fetch. Nobody hears about it: the kicker already has
 * its 202, so the 503 back-off in kick-drain.ts never sees this. Without a retry, the
 * text waited for a peer run to finish its own turn or for the next minute's cron.
 * Measured on the launch load probe (scripts/drain-load-probe.ts).
 */
export const KICKED_RUN_ATTEMPTS = 4;

/** The wait before retry n is n × this, scaled by a random 0.5–1.5, so the runs that
 * lost one race do not all return together and lose the next. Worst case about 13 s in
 * all, well inside a minute and far shorter than waiting for the cron. */
export const KICKED_RUN_RETRY_STEP_MS = 1_500;

export interface KickedDrainDeps {
  run: () => Promise<DrainSummary>;
  log: Pick<Console, 'info' | 'error'>;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
}

export const defaultKickedDrainTiming: Pick<KickedDrainDeps, 'sleep' | 'random'> = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random: Math.random,
};

/**
 * The body of a KICKED drain run, after route.ts has already answered the kicker 202. The
 * probe runs this same function, so what it measures is what the route does.
 *
 * Only a connection refusal is tried again: any other failure would fail the same way,
 * and the scheduled run is the floor under it. Every way out is logged once.
 */
export async function runKickedDrain(
  queues: readonly string[],
  deps: KickedDrainDeps,
): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const summary = await deps.run();
      deps.log.info({ ...summary, queues, attempts: attempt }, 'cron/drain kicked run complete');
      return;
    } catch (err) {
      const dbUnavailable = isConnectionExhaustion(err);
      if (!dbUnavailable || attempt >= KICKED_RUN_ATTEMPTS) {
        deps.log.error(
          { err, queues, dbUnavailable, attempts: attempt },
          'cron/drain kicked run failed',
        );
        return;
      }
      await deps.sleep(Math.round(KICKED_RUN_RETRY_STEP_MS * attempt * (0.5 + deps.random())));
    }
  }
}
