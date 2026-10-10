import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { auth } from '~/auth';
import { ConnectionUnavailable, OauthConsentScreen } from '~/components/hale/oauth-door';
import { db } from '~/lib/db';
import { resolveFamilyForUser, resolveUserIdForUser } from '~/lib/family';
import {
  type AuthorizationQuery,
  parseMcpAuthorizationRequest,
} from '~/lib/mcp/authorization-request';
import { mcpOriginFromHeaders } from '~/lib/mcp/http';
import { readMcpOauthClient } from '~/lib/mcp/oauth-store';

export const metadata: Metadata = { title: 'Allow access' };

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
    <OauthConsentScreen
      clientName={client.clientName}
      scopes={request.scopes}
      hidden={{
        responseType: request.responseType,
        clientId: request.clientId,
        redirectUri: request.redirectUri,
        resource: request.resource,
        rawScope: request.rawScope,
        codeChallenge: request.codeChallenge,
        codeChallengeMethod: request.codeChallengeMethod,
        state: request.state,
      }}
    />
  );
}
