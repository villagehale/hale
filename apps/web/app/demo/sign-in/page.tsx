import { ClaimByPhoneForm } from '~/components/hale/claim-by-phone-form';
import { ConnectStage } from '~/components/hale/connect/connect-stage';
import { DEMO_BASE } from '~/lib/portal/demo-fixture';

/** The phone door, rendered with no auth secret. Sending a code still needs the claim pipeline. */
export default function DemoSignInPage() {
  return (
    <ConnectStage>
      <ClaimByPhoneForm callbackUrl={`${DEMO_BASE}/home`} />
    </ConnectStage>
  );
}
