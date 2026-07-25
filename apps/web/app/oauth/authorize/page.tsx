import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { auth } from '~/auth';
import { AuthShell } from '~/components/hale/auth-shell';
import { db } from '~/lib/db';
import { resolveFamilyForUser, resolveUserIdForUser } from '~/lib/family';
import {
  type AuthorizationQuery,
  parseMcpAuthorizationRequest,
} from '~/lib/mcp/authorization-request';
import { mcpOriginFromHeaders } from '~/lib/mcp/http';
import { readMcpOauthClient } from '~/lib/mcp/oauth-store';
import { MCP_SCOPE_COPY } from '~/lib/mcp/scope-copy';

export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Promise<AuthorizationQuery>;
}

function internalCallback(query: AuthorizationQuery): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (typeof value === 'string') params.set(key, value);
  }
  return `/oauth/authorize?${params.toString()}`;
}

function ConnectionUnavailable({ detail }: { detail: string }) {
  return (
    <AuthShell heading="Connection unavailable" subtitle="Hale could not verify this request.">
      <div className="panel-oat px-5 py-4">
        <p className="text-spruce leading-relaxed">{detail}</p>
      </div>
      <a href="/home" className="btn-secondary self-start">
        Return to Hale
      </a>
    </AuthShell>
  );
}

export default async function McpAuthorizePage({ searchParams }: PageProps) {
  const query = await searchParams;
  const clientId = typeof query.client_id === 'string' ? query.client_id : null;
  const origin = mcpOriginFromHeaders(await headers());
  if (!origin || !clientId || clientId.length > 256) {
    return <ConnectionUnavailable detail="The assistant sent an invalid connection request." />;
  }

  const database = db();
  const client = await readMcpOauthClient(database, clientId);
  const request = client ? parseMcpAuthorizationRequest(query, client, origin) : null;
  if (!client || !request) {
    return <ConnectionUnavailable detail="The assistant or its callback could not be verified." />;
  }

  const session = await auth();
  const externalUserId = session?.user?.id;
  if (!externalUserId) {
    redirect(`/sign-in?callbackUrl=${encodeURIComponent(internalCallback(query))}`);
  }

  const [familyId, userId] = await Promise.all([
    resolveFamilyForUser(externalUserId, database),
    resolveUserIdForUser(externalUserId, database),
  ]);
  if (!familyId || !userId) {
    return (
      <ConnectionUnavailable detail="Finish setting up your Hale family before connecting an assistant." />
    );
  }

  return (
    <AuthShell
      heading={`Connect ${client.clientName}`}
      subtitle="Choose exactly what this third-party assistant may use."
    >
      <form action="/api/oauth/authorize" method="post" className="flex flex-col gap-y-5">
        <div className="panel-oat px-5 py-4">
          <p className="font-medium text-spruce">Before you connect</p>
          <p className="meta mt-2 leading-relaxed">
            Information the assistant reads may be processed under {client.clientName}&rsquo;s own
            privacy terms and AI model policies. Hale shares only the access you select below, and
            you can revoke it in Settings at any time.
          </p>
        </div>

        <fieldset className="flex flex-col gap-y-3">
          <legend className="eyebrow mb-1 text-spruce">requested access</legend>
          {request.scopes.map((scope) => {
            const copy = MCP_SCOPE_COPY[scope];
            return (
              <label
                key={scope}
                className="flex cursor-pointer items-start gap-3 border-b border-rule pb-3"
              >
                <input
                  type="checkbox"
                  name="granted_scope"
                  value={scope}
                  defaultChecked
                  className="mt-1 h-4 w-4 accent-spruce"
                />
                <span>
                  <span className="block font-medium text-spruce">{copy.label}</span>
                  <span className="meta mt-0.5 block leading-relaxed">{copy.detail}</span>
                </span>
              </label>
            );
          })}
        </fieldset>

        <p className="meta leading-relaxed">
          Even with “Propose actions,” this assistant can only create a draft. Nothing is booked,
          sent, changed, or purchased without a parent approving it inside Hale.
        </p>

        <input type="hidden" name="response_type" value={request.responseType} />
        <input type="hidden" name="client_id" value={request.clientId} />
        <input type="hidden" name="redirect_uri" value={request.redirectUri} />
        <input type="hidden" name="resource" value={request.resource} />
        <input type="hidden" name="requested_scope" value={request.rawScope} />
        <input type="hidden" name="code_challenge" value={request.codeChallenge} />
        <input type="hidden" name="code_challenge_method" value={request.codeChallengeMethod} />
        {request.state ? <input type="hidden" name="state" value={request.state} /> : null}

        <div className="flex flex-wrap gap-3">
          <button type="submit" name="decision" value="approve" className="btn-primary">
            Allow selected access
          </button>
          <button type="submit" name="decision" value="deny" className="btn-secondary">
            Cancel
          </button>
        </div>
      </form>
    </AuthShell>
  );
}
