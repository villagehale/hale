import { z } from 'zod';
import type { FetchLike } from '../browser-use/client';

export const LINK_API_BASE = 'https://api.link.com';
export const LINK_AUTH_BASE = 'https://login.link.com';
export const LINK_OAUTH_CLIENT_ID_ENV = 'LINK_OAUTH_CLIENT_ID';
export const LINK_OAUTH_CLIENT_SECRET_ENV = 'LINK_OAUTH_CLIENT_SECRET';
export const STRIPE_PUBLISHABLE_KEY_ENV = 'STRIPE_PUBLISHABLE_KEY';
/** Link refuses a spend request above $500. Hale's per-sign-up ceiling is the same. */
export const LINK_SPEND_CEILING_CENTS = 50_000;
export const LINK_WALLET_SCOPES = 'payment_methods.agentic userinfo:read';

/** Carries the status and the operation only: never a token or a card value. */
export class LinkApiError extends Error {
  readonly status: number;
  readonly operation: string;
  constructor(status: number, operation: string) {
    super(`link ${operation} failed with status ${status}`);
    this.name = 'LinkApiError';
    this.status = status;
    this.operation = operation;
  }
}

export interface LinkOAuthConfig {
  clientId: string;
  clientSecret: string;
  publishableKey: string;
}

export interface LinkTokens {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
  scope: string;
}

export interface LinkSpendRequest {
  id: string;
  status: string;
  amount: number;
  currency: string;
  approvalUrl: string | null;
}

/** A one-time card. Held in memory for one payment run; never logged or stored. */
export interface LinkCard {
  number: string;
  cvc: string | null;
  expMonth: number;
  expYear: number;
  postalCode: string | null;
}

export interface LinkSpendRequestInput {
  amountCents: number;
  currency: string;
  merchantName: string;
  merchantUrl: string;
  /** Shown to the parent in Link when they approve. At least 100 characters. */
  context: string;
  idempotencyKey: string;
}

export interface LinkOAuthApi {
  exchangeCode(input: {
    code: string;
    redirectUri: string;
    codeVerifier: string;
  }): Promise<LinkTokens>;
  refresh(refreshToken: string): Promise<LinkTokens>;
}

export interface LinkWalletApi {
  createSpendRequest(input: LinkSpendRequestInput): Promise<LinkSpendRequest>;
  retrieveSpendRequest(requestId: string): Promise<LinkSpendRequest>;
  retrieveCard(requestId: string): Promise<LinkCard | null>;
  cancelSpendRequest(requestId: string): Promise<void>;
}

const tokenResponse = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().int().positive(),
  scope: z.string().default(''),
});

const spendRequestResponse = z.object({
  id: z.string().min(1),
  status: z.string().min(1),
  amount: z.number().int(),
  currency: z.string(),
  approval_url: z.string().nullable().optional(),
  card: z
    .object({
      number: z.string().min(1),
      cvc: z.string().nullable().optional(),
      exp_month: z.number().int(),
      exp_year: z.number().int(),
      billing_address: z
        .object({ postal_code: z.string().nullable().optional() })
        .nullable()
        .optional(),
    })
    .nullable()
    .optional(),
});

/** The parent's own Link sign-in: OAuth authorization code with PKCE. */
export function linkAuthorizeUrl(input: {
  config: LinkOAuthConfig;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string {
  const url = new URL(`${LINK_AUTH_BASE}/auth`);
  url.searchParams.set('key', input.config.publishableKey);
  url.searchParams.set('client_id', input.config.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', LINK_WALLET_SCOPES);
  url.searchParams.set('state', input.state);
  url.searchParams.set('code_challenge', input.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.href;
}

export function linkOAuthApi(config: LinkOAuthConfig, fetchImpl: FetchLike): LinkOAuthApi {
  const token = async (operation: string, params: Record<string, string>): Promise<LinkTokens> => {
    const response = await fetchImpl(`${LINK_AUTH_BASE}/auth/token`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.publishableKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        ...params,
      }).toString(),
    });
    if (!response.ok) throw new LinkApiError(response.status, operation);
    const parsed = tokenResponse.safeParse(await response.json().catch(() => null));
    if (!parsed.success) throw new LinkApiError(response.status, `${operation}_shape`);
    return {
      accessToken: parsed.data.access_token,
      refreshToken: parsed.data.refresh_token,
      expiresInSeconds: parsed.data.expires_in,
      scope: parsed.data.scope,
    };
  };
  return {
    exchangeCode: ({ code, redirectUri, codeVerifier }) =>
      token('exchange_code', {
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
      }),
    refresh: (refreshToken) =>
      token('refresh', { grant_type: 'refresh_token', refresh_token: refreshToken }),
  };
}

/** Link API calls for one parent, authorized by their short-lived access token. */
export function linkWalletApi(accessToken: string, fetchImpl: FetchLike): LinkWalletApi {
  const call = async (operation: string, method: string, path: string, body?: unknown) => {
    const response = await fetchImpl(`${LINK_API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new LinkApiError(response.status, operation);
    const parsed = spendRequestResponse.safeParse(await response.json().catch(() => null));
    if (!parsed.success) throw new LinkApiError(response.status, `${operation}_shape`);
    return parsed.data;
  };
  const view = (request: z.infer<typeof spendRequestResponse>): LinkSpendRequest => ({
    id: request.id,
    status: request.status,
    amount: request.amount,
    currency: request.currency,
    approvalUrl: request.approval_url ?? null,
  });
  const id = (value: string) => encodeURIComponent(value);
  return {
    async createSpendRequest(input) {
      return view(
        await call('create_spend_request', 'POST', '/spend_requests', {
          credential_type: 'card',
          amount: input.amountCents,
          currency: input.currency,
          merchant_name: input.merchantName,
          merchant_url: input.merchantUrl,
          context: input.context,
          request_approval: true,
          idempotency_key: input.idempotencyKey,
        }),
      );
    },
    async retrieveSpendRequest(requestId) {
      return view(await call('retrieve_spend_request', 'GET', `/spend_requests/${id(requestId)}`));
    },
    async retrieveCard(requestId) {
      const request = await call(
        'retrieve_card',
        'GET',
        `/spend_requests/${id(requestId)}?include=card`,
      );
      if (!request.card) return null;
      return {
        number: request.card.number,
        cvc: request.card.cvc ?? null,
        expMonth: request.card.exp_month,
        expYear: request.card.exp_year,
        postalCode: request.card.billing_address?.postal_code ?? null,
      };
    },
    async cancelSpendRequest(requestId) {
      await call('cancel_spend_request', 'POST', `/spend_requests/${id(requestId)}/cancel`);
    },
  };
}

export type LinkOAuthConfigFromEnv =
  | { config: LinkOAuthConfig; skipped: null; missing: [] }
  | { config: null; skipped: 'not_configured'; missing: string[] };

/** Named absence until Stripe issues Hale a Link Agent Wallet OAuth client. */
export function linkOAuthConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): LinkOAuthConfigFromEnv {
  const read = (name: string) => env[name]?.trim() ?? '';
  const clientId = read(LINK_OAUTH_CLIENT_ID_ENV);
  const clientSecret = read(LINK_OAUTH_CLIENT_SECRET_ENV);
  const publishableKey = read(STRIPE_PUBLISHABLE_KEY_ENV);
  const missing = [
    [LINK_OAUTH_CLIENT_ID_ENV, clientId],
    [LINK_OAUTH_CLIENT_SECRET_ENV, clientSecret],
    [STRIPE_PUBLISHABLE_KEY_ENV, publishableKey],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name as string);
  if (missing.length > 0) return { config: null, skipped: 'not_configured', missing };
  return { config: { clientId, clientSecret, publishableKey }, skipped: null, missing: [] };
}
