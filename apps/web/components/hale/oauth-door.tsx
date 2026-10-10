import door from '~/components/portal/signin.module.css';
import type { McpScope } from '~/lib/mcp/contracts';
import { MCP_SCOPE_COPY } from '~/lib/mcp/scope-copy';
import { AuthShell } from './auth-shell';
import stage from './connect/connect.module.css';

/**
 * The door for an assistant Hale could not verify. Copy is the page's own.
 * Spacing comes from the sign-in stack and the stage button.
 */
export function ConnectionUnavailable({ detail }: { detail: string }) {
  return (
    <AuthShell heading="Connection unavailable" subtitle="Hale could not verify this request.">
      <div className="panel-oat px-5 py-4">
        <p className="text-spruce leading-relaxed">{detail}</p>
      </div>
      <a href="/home" className={`${stage.btn} ${door.full} ${door.returnHome}`}>
        Return to Hale
      </a>
    </AuthShell>
  );
}

export function OauthConsentScreen({
  clientName,
  scopes,
  hidden,
  action = '/api/oauth/authorize',
}: {
  clientName: string;
  scopes: readonly McpScope[];
  hidden: {
    responseType: string;
    clientId: string;
    redirectUri: string;
    resource: string;
    rawScope: string;
    codeChallenge: string;
    codeChallengeMethod: string;
    state?: string | null;
  };
  action?: string | ((formData: FormData) => void | Promise<void>);
}) {
  return (
    <AuthShell
      heading={`Connect ${clientName}`}
      subtitle="Choose exactly what this third-party assistant may use."
    >
      <form
        action={action}
        method={typeof action === 'string' ? 'post' : undefined}
        className="flex flex-col gap-y-5"
      >
        <div className="panel-oat px-5 py-4">
          <p className="font-medium text-spruce">Before you connect</p>
          <p className="meta mt-2 leading-relaxed">
            Information the assistant reads may be processed under {clientName}&rsquo;s own privacy
            terms and AI model policies. Hale shares only the access you select below, and you can
            revoke it in Settings at any time.
          </p>
        </div>

        <fieldset className="flex flex-col gap-y-3">
          <legend className={door.eyebrow}>requested access</legend>
          {scopes.map((scope) => {
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

        <input type="hidden" name="response_type" value={hidden.responseType} />
        <input type="hidden" name="client_id" value={hidden.clientId} />
        <input type="hidden" name="redirect_uri" value={hidden.redirectUri} />
        <input type="hidden" name="resource" value={hidden.resource} />
        <input type="hidden" name="requested_scope" value={hidden.rawScope} />
        <input type="hidden" name="code_challenge" value={hidden.codeChallenge} />
        <input type="hidden" name="code_challenge_method" value={hidden.codeChallengeMethod} />
        {hidden.state ? <input type="hidden" name="state" value={hidden.state} /> : null}

        <div className="flex flex-col">
          <button
            type="submit"
            name="decision"
            value="approve"
            className={`${stage.btn} ${door.full}`}
          >
            Allow selected access
          </button>
          <button type="submit" name="decision" value="deny" className={door.cancel}>
            Cancel
          </button>
        </div>
      </form>
    </AuthShell>
  );
}
