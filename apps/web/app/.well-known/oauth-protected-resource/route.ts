import { metadataCorsOptionsRequestHandler, protectedResourceHandler } from 'mcp-handler';
import { canonicalMcpResource } from '~/lib/mcp/contracts';
import { mcpRequestOrigin } from '~/lib/mcp/http';

export const dynamic = 'force-dynamic';

export function GET(req: Request): Response {
  const origin = mcpRequestOrigin(req);
  return protectedResourceHandler({
    authServerUrls: [origin],
    resourceUrl: canonicalMcpResource(origin),
  })(req);
}

export const OPTIONS = metadataCorsOptionsRequestHandler();
