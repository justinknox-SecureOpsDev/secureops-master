import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api, getToken, setToken, setUnauthorizedHandler } from "./api";

type User = { id: string; email: string; firstName: string; lastName: string; role: string };
type AuthCtx = {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  loginTotp: (challengeToken: string, code: string) => Promise<void>;
  logout: () => void;
};

const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const t = getToken();
    if (!t) { setLoading(false); return; }
    api<User>("/auth/me")
      .then((u) => setUser(u))
      .catch(() => setToken(null))
      .finally(() => setLoading(false));
  }, []);

  async function login(email: string, password: string) {
    const res = await api<{ token?: string; user?: User; needsTotp?: boolean; challengeToken?: string }>(
      "/auth/login",
      { method: "POST", body: { email, password } },
    );
    if (res.needsTotp && res.challengeToken) {
      // Caller (LoginPage) inspects the thrown sentinel and switches to
      // the 2FA challenge form. We stash the challenge token on the error
      // so it never touches React state until the second factor succeeds.
      const e = new Error("TOTP_REQUIRED") as Error & { challengeToken?: string };
      e.challengeToken = res.challengeToken;
      throw e;
    }
    if (!res.token || !res.user) throw new Error("Login failed");
    setToken(res.token);
    setUser(res.user);
  }
  async function loginTotp(challengeToken: string, code: string) {
    const res = await api<{ token: string; user: User }>("/auth/login-totp", {
      method: "POST",
      body: { challengeToken, code },
    });
    setToken(res.token);
    setUser(res.user);
  }
  function logout() {
    setToken(null);
    setUser(null);
  }

  // When any authenticated API call comes back 401 (expired/revoked session),
  // clear the dead session so the router falls back to the login screen instead
  // of every page (grids, dashboards) dead-ending on "failed".
  useEffect(() => {
    setUnauthorizedHandler(() => logout());
    return () => setUnauthorizedHandler(null);
  }, []);

  return <Ctx.Provider value={{ user, loading, login, loginTotp, logout }}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAuth must be used inside AuthProvider");
  return v;
}
