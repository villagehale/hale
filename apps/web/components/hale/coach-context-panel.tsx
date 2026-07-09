import type { ConnectionSummary } from '~/lib/integrations/store';

/** The connectors a family can link — the read-only Google services that feed the
 * pipeline. Mirrors the Settings → Connectors catalog so the two never drift. */
const CONNECTOR_CATALOG = [
  { provider: 'gcal', label: 'Google Calendar' },
  { provider: 'gmail', label: 'Gmail' },
  { provider: 'gdrive', label: 'Google Drive' },
] as const;

/** One connector chip in the coach Context panel — a family connector and
 * whether it is currently linked. Derived server-side from loadFamilyConnectors. */
export interface ConnectorChip {
  provider: string;
  label: string;
  connected: boolean;
}

/**
 * Maps the family's connection summaries onto the fixed connector catalog: every
 * connector Hale supports, marked connected when the family has an ACTIVE row for
 * it. Pure + exported so the Context panel is the same whether or not the family
 * has linked anything yet.
 */
export function connectorChips(connections: ConnectionSummary[]): ConnectorChip[] {
  return CONNECTOR_CATALOG.map((c) => ({
    provider: c.provider,
    label: c.label,
    connected: connections.some((x) => x.provider === c.provider && x.status === 'active'),
  }));
}
