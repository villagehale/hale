import Link from 'next/link';
import { passportLede } from '~/components/passport/lede';
import { FamilyBoard, KidPassport } from '~/components/passport/passport-controls';
import { PortalHeading } from '~/components/portal/heading';
import type { KidCard, PassportModel } from '~/lib/passport/read';
import './passport.css';

export function PassportHomeScreen({ model }: { model: PassportModel }) {
  return (
    <div className="pp-surface" data-testid="interest-passport">
      <PortalHeading title="Family" lede="Who Hale helps, and who can see it." />
      <FamilyBoard model={model} />
      {model.unassigned.length > 0 ? (
        <p className="pp-meta">{model.unassigned.length} stamp needs a child before it can land.</p>
      ) : null}
    </div>
  );
}

export function PassportKidScreen({
  model,
  kid,
  initialStampId,
}: {
  model: PassportModel;
  kid: KidCard;
  initialStampId?: string | null;
}) {
  return (
    <div className="pp-surface" data-testid="interest-passport">
      <p className="pp-crumb">
        <Link href="/family">Family</Link>
        <span aria-hidden="true"> › </span>
        <span>{kid.name}</span>
      </p>
      <PortalHeading title={kid.name} lede={passportLede(kid)} />
      <KidPassport model={model} kid={kid} initialStampId={initialStampId} />
    </div>
  );
}
