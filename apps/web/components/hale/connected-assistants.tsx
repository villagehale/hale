import type { McpConnectionSummary } from '~/lib/mcp/oauth-store';
import { MCP_SCOPE_COPY } from '~/lib/mcp/scope-copy';
import { McpRevokeForm } from './mcp-revoke-form';

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    dateStyle: 'medium',
    timeZone: 'UTC',
  }).format(new Date(value));
}

/**
 * Settings → Connected apps. Only parent-facing connection metadata is rendered:
 * never the token hash, token prefix, client id, consent id, or grant id as text.
 */
export function ConnectedAssistants({
  connections,
}: {
  connections: McpConnectionSummary[];
}) {
  return (
    <div className="flex flex-col gap-y-5">
      <p className="max-w-md text-spruce leading-relaxed">
        Assistants connect with only the access you approve. Hale keeps teen and sensitive details
        redacted, and proposed actions still wait for your approval here.
      </p>

      {connections.length === 0 ? (
        <div className="panel-oat px-6 py-5">
          <p className="font-medium text-spruce">No assistants connected</p>
          <p className="meta mt-1 leading-relaxed">
            A compatible assistant will bring you to Hale to review its access before anything is
            shared.
          </p>
        </div>
      ) : (
        <ul className="flex flex-col divide-y divide-rule border-y border-rule">
          {connections.map((connection) => (
            <li
              key={connection.id}
              className="flex flex-col gap-4 py-5 sm:flex-row sm:items-start sm:justify-between"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <p className="font-medium text-spruce">{connection.clientName}</p>
                  <span className="meta text-faded-sage">connected</span>
                </div>
                <ul className="mt-2 flex flex-wrap gap-x-2 gap-y-1" aria-label="Allowed access">
                  {connection.scopes.map((scope) => (
                    <li key={scope} className="meta">
                      {MCP_SCOPE_COPY[scope].label}
                    </li>
                  ))}
                </ul>
                <p className="meta mt-2">
                  {connection.lastUsedAt
                    ? `Last used ${formatDate(connection.lastUsedAt)}`
                    : 'Not used yet'}
                  {' · '}
                  Access expires {formatDate(connection.expiresAt)}
                </p>
              </div>

              <McpRevokeForm grantId={connection.id} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
