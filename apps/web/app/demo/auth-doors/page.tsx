import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AuthShell } from '~/components/hale/auth-shell';
import { ForgotPasswordForm } from '~/components/hale/forgot-password-form';
import { MagicLinkRedeem } from '~/components/hale/magic-link-redeem';
import { ConnectionUnavailable, OauthConsentScreen } from '~/components/hale/oauth-door';
import { ResetPasswordForm } from '~/components/hale/reset-password-form';
import door from '~/components/portal/signin.module.css';
import {
  MAGIC_LINK_INVALID,
  PASSWORD_RESET_INVALID,
  PASSWORD_RESET_UNAVAILABLE,
} from '~/lib/auth/door-messages';
import { MCP_SCOPES } from '~/lib/mcp/contracts';
import {
  demoConsentAction,
  demoForgotAction,
  demoForgotErrorAction,
  demoMagicAction,
  demoResetAction,
} from './stubs';

export const dynamic = 'force-dynamic';

const VIEWS = [
  'forgot',
  'forgot-error',
  'forgot-sent',
  'reset',
  'reset-error',
  'magic',
  'magic-error',
  'oauth',
  'oauth-unavailable',
] as const;

type View = (typeof VIEWS)[number];

const TITLES: Record<View, string> = {
  forgot: 'Reset password',
  'forgot-error': 'Reset password',
  'forgot-sent': 'Reset password',
  reset: 'New password',
  'reset-error': 'New password',
  magic: 'Sign in',
  'magic-error': 'Sign in',
  oauth: 'Allow access',
  'oauth-unavailable': 'Allow access',
};

function isView(value: string | undefined): value is View {
  return VIEWS.some((view) => view === value);
}

export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}): Promise<Metadata> {
  const view = (await searchParams).view;
  return { title: isView(view) ? TITLES[view] : 'Reset password' };
}

/**
 * Preview-only doors so Design can see the live form, error, and sent markup.
 * The parent /demo layout 404s this on production. Actions here never send mail
 * or spend a token.
 */
export default async function DemoAuthDoorsPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const view = (await searchParams).view ?? 'forgot';
  if (!isView(view)) notFound();

  if (view === 'forgot' || view === 'forgot-error' || view === 'forgot-sent') {
    return (
      <AuthShell heading="Reset your password">
        <ForgotPasswordForm
          action={view === 'forgot-error' ? demoForgotErrorAction : demoForgotAction}
          initialState={
            view === 'forgot-sent'
              ? { status: 'sent' }
              : view === 'forgot-error'
                ? { status: 'error', message: PASSWORD_RESET_UNAVAILABLE }
                : { status: 'idle' }
          }
        />
        <p className={door.new}>
          <Link href="/sign-in">Remembered it? Back to sign in &rarr;</Link>
        </p>
      </AuthShell>
    );
  }

  if (view === 'reset' || view === 'reset-error') {
    return (
      <AuthShell heading="Choose a new password">
        <ResetPasswordForm
          token="preview"
          action={demoResetAction}
          initialState={
            view === 'reset-error'
              ? { status: 'error', message: PASSWORD_RESET_INVALID }
              : { status: 'idle' }
          }
        />
        <p className={door.new}>
          <Link href="/forgot-password">Need a new link? Start over &rarr;</Link>
        </p>
      </AuthShell>
    );
  }

  if (view === 'magic' || view === 'magic-error') {
    return (
      <AuthShell heading="Sign in to Hale">
        <MagicLinkRedeem
          token="preview"
          redirectTo="/home"
          action={demoMagicAction}
          submitOnMount={false}
          initialState={
            view === 'magic-error'
              ? { status: 'error', message: MAGIC_LINK_INVALID }
              : { status: 'idle' }
          }
        />
      </AuthShell>
    );
  }

  if (view === 'oauth-unavailable') {
    return <ConnectionUnavailable detail="The assistant sent an invalid connection request." />;
  }

  return (
    <OauthConsentScreen
      clientName="Assistant"
      scopes={MCP_SCOPES}
      action={demoConsentAction}
      hidden={{
        responseType: 'code',
        clientId: 'preview',
        redirectUri: 'https://example.com/callback',
        resource: 'https://example.com/api/mcp',
        rawScope: MCP_SCOPES.join(' '),
        codeChallenge: 'preview',
        codeChallengeMethod: 'S256',
      }}
    />
  );
}
