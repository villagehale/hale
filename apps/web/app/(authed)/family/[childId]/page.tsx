import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { PassportKidScreen } from '~/components/passport/passport-screens';
import { interestPassportEnabled } from '~/lib/passport/flag';
import { kidById, readPassportModel } from '~/lib/passport/read';

// The child's name stays on the page (data-hale-pii) and out of the tab.
export const metadata: Metadata = { title: 'Family' };

export default async function ChildPassportPage({
  params,
  searchParams,
}: {
  params: Promise<{ childId: string }>;
  searchParams: Promise<{ stamp?: string }>;
}) {
  if (!interestPassportEnabled()) notFound();
  const [{ childId }, query] = await Promise.all([params, searchParams]);
  const model = await readPassportModel();
  const kid = kidById(model, childId);
  if (!kid) notFound();
  return <PassportKidScreen model={model} kid={kid} initialStampId={query.stamp ?? null} />;
}
