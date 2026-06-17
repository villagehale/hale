// Meadow-themed Clerk appearance — maps Clerk's widget slots onto the design
// tokens in app/globals.css (Fraunces display, Nunito body, spruce/apricot/linen
// palette) so the hosted <SignIn>/<SignUp> cards read as part of Hale, not Clerk.
// Typed structurally (no @clerk/types import — it isn't hoisted to this app); the
// object is validated against the <SignIn>/<SignUp> `appearance` prop at its use site.
export const meadowAppearance = {
  variables: {
    colorPrimary: '#01204F',
    colorText: '#01204F',
    colorTextSecondary: '#33486b',
    colorBackground: '#f6f1e7',
    colorInputBackground: '#f6f1e7',
    colorInputText: '#01204F',
    colorDanger: '#9c3b54',
    fontFamily: '"Nunito", -apple-system, "Segoe UI", system-ui, sans-serif',
    borderRadius: '14px',
  },
  elements: {
    card: {
      backgroundColor: '#efe7d6',
      boxShadow: 'none',
      border: '1px solid rgb(1 32 79 / 0.10)',
    },
    headerTitle: {
      fontFamily: '"Fraunces", "Iowan Old Style", "Charter", Georgia, serif',
      fontWeight: 420,
    },
    formButtonPrimary: {
      backgroundColor: '#01204F',
      color: '#FEFEFE',
      fontWeight: 700,
      textTransform: 'none',
    },
    footerActionLink: {
      color: '#a84e20',
    },
  },
} as const;
