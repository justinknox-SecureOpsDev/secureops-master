import React, { createContext, useContext, useState, useEffect, useCallback, ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { User, setUnauthorizedHandler } from "@workspace/api-client-react";
import { storage } from "@/utils/storage";
import {
  isBiometricEnabled,
  promptBiometric,
} from "@/utils/biometric";

interface AuthContextType {
  user: User | null;
  token: string | null;
  isLoading: boolean;
  /** True while we're waiting for the user to pass the biometric prompt. */
  awaitingBiometric: boolean;
  login: (user: User, token: string) => Promise<void>;
  logout: () => Promise<void>;
  /** Updates the cached user (e.g. after change-password / patch profile). */
  updateUser: (patch: Partial<User>) => Promise<void>;
  /** Replaces the JWT (e.g. rotated after change-password). */
  setToken: (token: string) => Promise<void>;
  /** Re-attempts the biometric unlock when the user picks "Try again". */
  retryBiometric: () => Promise<void>;
  /** Discards the cached session and routes back to login. */
  cancelBiometric: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | null>(null);

export const AUTH_TOKEN_KEY = "auth_token";
export const AUTH_USER_KEY = "auth_user";

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [token, setTokenState] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [awaitingBiometric, setAwaitingBiometric] = useState(false);
  const queryClient = useQueryClient();

  const tryRestoreCachedSession = useCallback(async () => {
    const storedToken = await storage.get(AUTH_TOKEN_KEY);
    const storedUser = await storage.get(AUTH_USER_KEY);
    if (!storedToken || !storedUser) {
      setIsLoading(false);
      return;
    }
    const parsedUser: User = JSON.parse(storedUser);
    const bioEnabled = await isBiometricEnabled();
    if (!bioEnabled) {
      setTokenState(storedToken);
      setUser(parsedUser);
      setIsLoading(false);
      return;
    }
    setAwaitingBiometric(true);
    setIsLoading(false);
    const ok = await promptBiometric(`Unlock ${process.env.EXPO_PUBLIC_APP_NAME ?? "SecureOps"}`);
    if (ok) {
      setTokenState(storedToken);
      setUser(parsedUser);
      setAwaitingBiometric(false);
    }
    // Otherwise stay locked — user picks Try again or Sign in with password.
  }, []);

  useEffect(() => {
    tryRestoreCachedSession().catch((e) => {
      console.error("Failed to restore session", e);
      setIsLoading(false);
    });
  }, [tryRestoreCachedSession]);

  const login = async (newUser: User, newToken: string) => {
    // Drop any cached query data from a previous session so one user can never
    // see another's data (e.g. an admin's cached payroll/invoices surfacing to
    // a lead who signs in next on the same device).
    queryClient.clear();
    setUser(newUser);
    setTokenState(newToken);
    setAwaitingBiometric(false);
    await storage.set(AUTH_TOKEN_KEY, newToken);
    await storage.set(AUTH_USER_KEY, JSON.stringify(newUser));
  };

  const logout = async () => {
    setUser(null);
    setTokenState(null);
    setAwaitingBiometric(false);
    await storage.remove(AUTH_TOKEN_KEY);
    await storage.remove(AUTH_USER_KEY);
    // Purge cached query data so the next user on this device starts clean.
    queryClient.clear();
  };

  const updateUser = async (patch: Partial<User>) => {
    setUser((prev) => {
      if (!prev) return prev;
      const next = { ...prev, ...patch };
      storage.set(AUTH_USER_KEY, JSON.stringify(next)).catch(() => {});
      return next;
    });
  };

  const setToken = async (newToken: string) => {
    setTokenState(newToken);
    await storage.set(AUTH_TOKEN_KEY, newToken);
  };

  const retryBiometric = async () => {
    const ok = await promptBiometric(`Unlock ${process.env.EXPO_PUBLIC_APP_NAME ?? "SecureOps"}`);
    if (ok) {
      const storedToken = await storage.get(AUTH_TOKEN_KEY);
      const storedUser = await storage.get(AUTH_USER_KEY);
      if (storedToken && storedUser) {
        setTokenState(storedToken);
        setUser(JSON.parse(storedUser));
        setAwaitingBiometric(false);
      }
    }
  };

  const cancelBiometric = async () => {
    setAwaitingBiometric(false);
    await logout();
  };

  // When any authenticated API call comes back 401 (expired/revoked session),
  // clear the dead session so RootLayoutNav routes the user back to login
  // instead of every screen dead-ending on "failed to load".
  useEffect(() => {
    setUnauthorizedHandler(() => {
      void logout();
    });
    return () => setUnauthorizedHandler(null);
    // logout only closes over stable state setters + storage; register once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <AuthContext.Provider value={{
      user, token, isLoading, awaitingBiometric,
      login, logout, updateUser, setToken,
      retryBiometric, cancelBiometric,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
