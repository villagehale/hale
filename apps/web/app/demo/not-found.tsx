import type { Metadata } from 'next';
import NotFound from '../not-found';

/** Absolute, so the demo layout's "%s · Hale preview" template cannot suffix it. */
export const metadata: Metadata = { title: { absolute: 'Page not found · Hale' } };

export default function DemoNotFound() {
  return <NotFound />;
}
