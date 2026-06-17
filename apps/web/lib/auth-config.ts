// Single source of truth for whether Clerk auth is wired. Both the middleware
// and the (authed) layout read this so the auth gate and the dev-preview
// fallback can never disagree about which mode the app is in.
export function clerkConfigured(): boolean {
  return Boolean(
    process.env.CLERK_SECRET_KEY && process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
  );
}

// Client-safe companion: only the publishable key is inlined into client
// bundles (CLERK_SECRET_KEY is server-only and is `undefined` in the browser).
// Use this in client components; use clerkConfigured() on the server.
export function clerkPubliclyConfigured(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);
}
