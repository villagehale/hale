import type { SideTurnPorts } from './side-turn';

/**
 * The side-turn port with INBOUND_MIDTURN dark, for router tests that are not about it.
 * Every call is recorded, and anything past `enabled` throws: a dark watcher must not
 * read, sleep or ask a model. A fixture, never imported by production code.
 */
export function darkSideTurn(): SideTurnPorts & { calls: string[] } {
  const calls: string[] = [];
  const touched = (port: string): never => {
    calls.push(port);
    throw new Error(`side turn is dark: ${port} was called`);
  };
  return {
    calls,
    enabled: (familyId) => {
      calls.push(`enabled:${familyId}`);
      return false;
    },
    reader: { read: async () => touched('reader') },
    family: async () => touched('family'),
    sleep: async () => touched('sleep'),
  };
}
