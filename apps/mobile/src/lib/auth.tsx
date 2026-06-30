import { type ReactNode, createContext, useContext, useEffect, useMemo, useState } from 'react';

import { tokenStorage } from './token-storage';

const TOKEN_KEY = 'hale.session.token';

type AuthState = {
  token: string | null;
  isLoading: boolean;
  signIn: (token: string) => Promise<void>;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    tokenStorage
      .get(TOKEN_KEY)
      .then(setToken)
      .finally(() => setIsLoading(false));
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      token,
      isLoading,
      signIn: async (next) => {
        await tokenStorage.set(TOKEN_KEY, next);
        setToken(next);
      },
      signOut: async () => {
        await tokenStorage.remove(TOKEN_KEY);
        setToken(null);
      },
    }),
    [token, isLoading],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
