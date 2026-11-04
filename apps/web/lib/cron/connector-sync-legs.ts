/**
 * The connector-sync cron's legs, in order, each in its own try.
 *
 * The two Google revoke legs run FIRST. A pending revoke holds a live refresh token that
 * Hale keeps only to revoke it (VIL-156); behind the poll sweep, a throw or a spent
 * `maxDuration` starved them. Each leg's outcome is named in the JSON, and a failed leg
 * never stops the next one.
 */

type Leg = () => Promise<object>;

export interface ConnectorSweepLegs {
  googleRevokeExpiry: Leg;
  googleRevokeRetry: Leg;
  sync: Leg;
  pushRenewal: Leg;
}

export type LegOutcome = ({ status: 'ok' } & object) | { status: 'failed'; error: string };

const ORDER: ReadonlyArray<keyof ConnectorSweepLegs> = [
  'googleRevokeExpiry',
  'googleRevokeRetry',
  'sync',
  'pushRenewal',
];

async function runLeg(name: keyof ConnectorSweepLegs, leg: Leg): Promise<LegOutcome> {
  try {
    return { status: 'ok', ...(await leg()) };
  } catch (err) {
    // The error's class only: a provider or driver message can carry a row (rule #1).
    const error = err instanceof Error ? err.name : 'unknown';
    console.error({ leg: name, error }, 'connector-sync: leg failed');
    return { status: 'failed', error };
  }
}

export async function runConnectorSweepLegs(
  legs: ConnectorSweepLegs,
): Promise<{ ok: boolean } & Record<keyof ConnectorSweepLegs, LegOutcome>> {
  const outcomes = {} as Record<keyof ConnectorSweepLegs, LegOutcome>;
  for (const name of ORDER) {
    outcomes[name] = await runLeg(name, legs[name]);
  }
  return {
    ok: ORDER.every((name) => outcomes[name].status === 'ok'),
    ...outcomes,
  };
}
