// Client-safe auth constants. Kept free of server-only imports (node:crypto,
// argon2, the db) so a client form component can import the password-length rule
// without dragging the server runtime into the browser bundle.
export const MIN_PASSWORD_LENGTH = 10;
export const MAX_PASSWORD_LENGTH = 200;
