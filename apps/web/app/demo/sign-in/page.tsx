import { ClaimByPhoneForm } from '~/components/hale/claim-by-phone-form';
import { ConnectStage } from '~/components/hale/connect/connect-stage';
import { DEMO_BASE, demoSmsHref } from '~/lib/portal/demo-fixture';
import { parsePortalSourceCode } from '~/lib/text-hale-target';

/** The phone door, rendered with no auth secret. Sending a code still needs the claim pipeline. */
export default async function DemoSignInPage({
  searchParams,
}: {
  searchParams?: Promise<{ s?: string | string[] }>;
}) {
  const source = parsePortalSourceCode((await searchParams)?.s);
  return (
    <ConnectStage>
      <ClaimByPhoneForm
        callbackUrl={`${DEMO_BASE}/home`}
        smsNumber={demoSmsHref()?.slice('sms:'.length) ?? ''}
        source={source}
      />
    </ConnectStage>
  );
}
