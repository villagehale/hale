import { redirect } from 'next/navigation';
import { auth } from '~/auth';
import { authConfigured } from '~/lib/auth-config';

// The app domain (app.villagehale.com) is the product, not a marketing page —
// that lives at villagehale.com. For the soft launch there is no open "set up
// your family" entry here: invited users arrive via their invite link →
// /onboarding (gated), and returning users sign in. So the root only routes by
// session. authConfigured()/auth() read runtime secrets — never bake at build.
export const dynamic = 'force-dynamic';

export default async function AppRoot() {
  if (authConfigured()) {
    const session = await auth();
    redirect(session?.user?.id ? '/home' : '/sign-in');
  }
  // Local dev preview (Google not configured): open the app shell directly.
  redirect('/home');
}
