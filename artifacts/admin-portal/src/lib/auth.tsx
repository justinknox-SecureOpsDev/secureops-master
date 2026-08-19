import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api, getToken, setToken, setUnauthorizedHandler } from "./api";
import { setUnauthorizedHandler as setGeneratedClientUnauthorizedHandler } from "@workspace/api-client-react";

type User = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: string;
  mustChangePassword?: boolean;
  /** Per-user UI personalization (e.g. portal nav group order). Cosmetic only. */
  uiPreferences?: { navGroupOrder?: string[] };
  /**
   * Company-owner flag — INDEPENDENT of role. Gates ONLY the aggregate
   * financial dashboards (revenue/margin/profit KPIs, payroll & invoice
   * board totals, financial exports). Always re-read live from the server
   * on every /auth/me call; the UI must treat it as advisory only — every
   * gated endpoint enforces this server-side regardless of what this shows.
   */
  isCompanyOwner?: boolean;
};
type AuthCtx = {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  loginTotp: (challengeToken: string, code: string) => Promise<void>;
  logout: () => void;
  /** Swap in a fresh session (token + user) — used after a mandatory
   *  first-login password change rotates the JWT server-side. */
  applySession: (token: string, user: User) => void;
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
  function applySession(token: string, u: User) {
    setToken(token);
    setUser(u);
  }

  // When any authenticated API call comes back 401 (expired/revoked session),
  // clear the dead session so the router falls back to the login screen instead
  // of every page (grids, dashboards) dead-ending on "failed". Registered for
  // BOTH HTTP paths: the legacy api()/fetchWithAuth helper and the generated
  // @workspace/api-client-react client (which only notifies when the request
  // actually carried a token, matching api()'s token-was-sent gating).
  useEffect(() => {
    setUnauthorizedHandler(() => logout());
    setGeneratedClientUnauthorizedHandler(() => logout());
    return () => {
      setUnauthorizedHandler(null);
      setGeneratedClientUnauthorizedHandler(null);
    };
  }, []);

  return <Ctx.Provider value={{ user, loading, login, loginTotp, logout, applySession }}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAuth must be used inside AuthProvider");
  return v;
}
