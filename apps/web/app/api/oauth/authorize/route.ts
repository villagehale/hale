import { NextResponse } from 'next/server';
import { auth } from '~/auth';
import { db } from '~/lib/db';
import { resolveFamilyForUser, resolveUserIdForUser } from '~/lib/family';
import {
  type AuthorizationQuery,
  parseMcpAuthorizationRequest,
} from '~/lib/mcp/authorization-request';
import { MCP_SCOPES, type McpScope, isMcpScope } from '~/lib/mcp/contracts';
import { hasExpectedOrigin, mcpRequestOrigin, oauthRedirect } from '~/lib/mcp/http';
import { createMcpAuthorizationCode, readMcpOauthClient } from '~/lib/mcp/oauth-store';
import { enforceRateLimit } from '~/lib/rate-limit/apply';

export const runtime = 'nodejs';

function text(form: FormData, key: string): string | undefined {
  const value = form.get(key);
  return typeof value === 'string' ? value : undefined;
}

export async function POST(req: Request): Promise<Response> {
  const origin = mcpRequestOrigin(req);
  if (!hasExpectedOrigin(req, origin)) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 403 });
  }

  const form = await req.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: 'invalid_request' }, { status: 400 });

  const clientId = text(form, 'client_id');
  if (!clientId || clientId.length > 256) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }

  const database = db();
  const client = await readMcpOauthClient(database, clientId);
  if (!client) return NextResponse.json({ error: 'invalid_request' }, { status: 400 });

  const query: AuthorizationQuery = {
    response_type: text(form, 'response_type'),
    client_id: clientId,
    redirect_uri: text(form, 'redirect_uri'),
    resource: text(form, 'resource'),
    scope: text(form, 'requested_scope'),
    state: text(form, 'state'),
    code_challenge: text(form, 'code_challenge'),
    code_challenge_method: text(form, 'code_challenge_method'),
  };
  const authorization = parseMcpAuthorizationRequest(query, client, origin);
  if (!authorization) {
    // Never redirect untrusted input. The exact registered redirect URI must pass
    // before either an OAuth error or a code is sent back to the client.
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }

  const session = await auth();
  const externalUserId = session?.user?.id;
  if (!externalUserId) {
    return NextResponse.json({ error: 'login_required' }, { status: 401 });
  }
  const limited = await enforceRateLimit('mcp-authorize', externalUserId, true);
  if (limited) return limited;

  if (text(form, 'decision') === 'deny') {
    return NextResponse.redirect(
      oauthRedirect(authorization.redirectUri, {
        error: 'access_denied',
        state: authorization.state,
        iss: origin,
      }),
      303,
    );
  }
  if (text(form, 'decision') !== 'approve') {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }

  const selectedRaw = form.getAll('granted_scope');
  const selected = selectedRaw.filter(
    (scope): scope is McpScope => typeof scope === 'string' && isMcpScope(scope),
  );
  if (
    selected.length === 0 ||
    selected.length !== selectedRaw.length ||
    new Set(selected).size !== selected.length ||
    selected.some((scope) => !authorization.scopes.includes(scope))
  ) {
    return NextResponse.redirect(
      oauthRedirect(authorization.redirectUri, {
        error: 'invalid_scope',
        state: authorization.state,
        iss: origin,
      }),
      303,
    );
  }
  const scopes = MCP_SCOPES.filter((scope) => selected.includes(scope));

  const [familyId, userId] = await Promise.all([
    resolveFamilyForUser(externalUserId, database),
    resolveUserIdForUser(externalUserId, database),
  ]);
  if (!familyId || !userId) {
    return NextResponse.redirect(
      oauthRedirect(authorization.redirectUri, {
        error: 'access_denied',
        state: authorization.state,
        iss: origin,
      }),
      303,
    );
  }

  const code = await createMcpAuthorizationCode(database, {
    clientId: authorization.clientId,
    userId,
    familyId,
    redirectUri: authorization.redirectUri,
    resource: authorization.resource,
    scopes,
    codeChallenge: authorization.codeChallenge,
    ip: req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || undefined,
    userAgent: req.headers.get('user-agent') ?? undefined,
  });

  return NextResponse.redirect(
    oauthRedirect(authorization.redirectUri, { code, state: authorization.state, iss: origin }),
    303,
  );
}
