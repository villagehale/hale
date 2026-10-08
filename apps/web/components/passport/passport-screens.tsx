import Link from 'next/link';
import { passportLede } from '~/components/passport/lede';
import { FamilyBoard, KidPassport } from '~/components/passport/passport-controls';
import { PassportFrame } from '~/components/passport/passport-frame';
import type { KidCard, PassportModel } from '~/lib/passport/read';

export function PassportHomeScreen({ model }: { model: PassportModel }) {
  return (
    <PassportFrame>
      <h1>Family</h1>
      <p className="pp-lede">Who Hale helps, and who can see it.</p>
      <FamilyBoard model={model} />
      {model.unassigned.length > 0 ? (
        <p className="pp-meta">{model.unassigned.length} stamp needs a child before it can land.</p>
      ) : null}
      <PassportFooter />
    </PassportFrame>
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
    <PassportFrame>
      <Link className="pp-back" href="/family">
        <BackChevron />
        Family
      </Link>
      <h1>{kid.name}</h1>
      <p className="pp-lede">{passportLede(kid)}</p>
      <KidPassport model={model} kid={kid} initialStampId={initialStampId} />
      <PassportFooter />
    </PassportFrame>
  );
}

function PassportFooter() {
  return (
    <footer className="pp-foot">
      <span>
        Never sold. <a href="https://villagehale.com/privacy">Privacy policy</a>
      </span>
      <span>Hale /HAH-leh/ — Hawaiian for home.</span>
    </footer>
  );
}

function BackChevron() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M12 4.5 6.5 10l5.5 5.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
