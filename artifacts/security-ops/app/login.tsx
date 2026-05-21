import React, { useState } from "react";
import {
  View, Text, TextInput, TouchableOpacity,
  StyleSheet, ActivityIndicator, Image,
} from "react-native";
import * as WebBrowser from "expo-web-browser";
import { useRouter } from "expo-router";
import { useAuth } from "@/contexts/AuthContext";
import { useColors } from "@/hooks/useColors";
import { SafeAreaView } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import { API_BASE_URL } from "@/utils/api";

async function postJson<T>(path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    throw new Error(
      `Can't reach the server (${reason}). Check your internet connection and try again.`,
    );
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as any)?.message || `HTTP ${res.status}`);
  return data as T;
}

export default function LoginScreen() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [challengeToken, setChallengeToken] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const { login: setAuthContext } = useAuth();
  const colors = useColors();
  const router = useRouter();

  const handleLogin = async () => {
    if (!email || !password) return;
    setBusy(true); setError(null);
    try {
      const res = await postJson<{ token?: string; user?: any; needsTotp?: boolean; challengeToken?: string }>(
        "/auth/login",
        { email, password },
      );
      if (res.needsTotp && res.challengeToken) {
        setChallengeToken(res.challengeToken);
      } else if (res.token && res.user) {
        await setAuthContext(res.user, res.token);
      } else {
        setError("Unexpected response from server.");
      }
    } catch (e: any) {
      setError(e?.message || "Invalid credentials. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const handleVerifyTotp = async () => {
    if (!challengeToken || !code) return;
    setBusy(true); setError(null);
    try {
      const res = await postJson<{ token: string; user: any }>(
        "/auth/login-totp",
        { challengeToken, code },
      );
      await setAuthContext(res.user, res.token);
    } catch (e: any) {
      setError(e?.message || "Invalid code. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const cancelTotp = () => {
    setChallengeToken(null); setCode(""); setError(null);
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Gold radial glow behind logo */}
      <View style={styles.glow} />

      <View style={styles.content}>
        {/* Logo */}
        <View style={styles.logoWrap}>
          <Image
            source={require("@/assets/images/logo.png")}
            style={styles.logo}
            resizeMode="contain"
          />
        </View>

        {/* Brand text */}
        <View style={styles.brandBlock}>
          <Text style={[styles.brandName, { color: colors.primary }]}>{(process.env.EXPO_PUBLIC_COMPANY_NAME ?? "Williams Council Security Group").toUpperCase()}</Text>
          <View style={styles.dividerRow}>
            <View style={[styles.dividerLine, { backgroundColor: colors.primary }]} />
            <Text style={[styles.motto, { color: colors.mutedForeground }]}>PROTECTION WITH PASSION</Text>
            <View style={[styles.dividerLine, { backgroundColor: colors.primary }]} />
          </View>
        </View>

        {/* Login card */}
        <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text style={[styles.cardTitle, { color: colors.foreground }]}>COMMAND ACCESS</Text>

          {error && (
            <View style={[styles.errorBox, { backgroundColor: colors.destructive + "25", borderColor: colors.destructive }]}>
              <Feather name="alert-circle" size={14} color={colors.destructive} />
              <Text style={{ color: colors.destructive, fontSize: 13, flex: 1 }}>{error}</Text>
            </View>
          )}

          {!challengeToken ? (
            <>
              <View style={[styles.inputWrap, { borderColor: colors.border, backgroundColor: colors.secondary }]}>
                <Feather name="mail" size={16} color={colors.mutedForeground} />
                <TextInput
                  style={[styles.input, { color: colors.foreground }]}
                  placeholder="Email address"
                  placeholderTextColor={colors.mutedForeground}
                  value={email}
                  onChangeText={setEmail}
                  autoCapitalize="none"
                  keyboardType="email-address"
                />
              </View>

              <View style={[styles.inputWrap, { borderColor: colors.border, backgroundColor: colors.secondary }]}>
                <Feather name="lock" size={16} color={colors.mutedForeground} />
                <TextInput
                  style={[styles.input, { color: colors.foreground }]}
                  placeholder="Password"
                  placeholderTextColor={colors.mutedForeground}
                  value={password}
                  onChangeText={setPassword}
                  secureTextEntry={!showPassword}
                />
                <TouchableOpacity onPress={() => setShowPassword(!showPassword)}>
                  <Feather name={showPassword ? "eye-off" : "eye"} size={16} color={colors.mutedForeground} />
                </TouchableOpacity>
              </View>

              <TouchableOpacity
                style={[styles.button, { backgroundColor: colors.primary, opacity: busy ? 0.8 : 1 }]}
                onPress={handleLogin}
                disabled={busy}
              >
                {busy ? (
                  <ActivityIndicator color={colors.primaryForeground} />
                ) : (
                  <>
                    <Feather name="shield" size={16} color={colors.primaryForeground} />
                    <Text style={[styles.buttonText, { color: colors.primaryForeground }]}>ACCESS SYSTEM</Text>
                  </>
                )}
              </TouchableOpacity>

              <TouchableOpacity
                onPress={() => router.push("/forgot-password")}
                style={styles.forgotRow}
              >
                <Text style={[styles.forgotText, { color: colors.mutedForeground }]}>
                  Forgot password?
                </Text>
              </TouchableOpacity>
            </>
          ) : (
            <>
              <Text style={{ color: colors.mutedForeground, fontSize: 13, textAlign: "center" }}>
                Enter the 6-digit code from your authenticator app, or a recovery code.
              </Text>
              <View style={[styles.inputWrap, { borderColor: colors.border, backgroundColor: colors.secondary }]}>
                <Feather name="key" size={16} color={colors.mutedForeground} />
                <TextInput
                  style={[styles.input, { color: colors.foreground, letterSpacing: 4, textAlign: "center", fontSize: 18 }]}
                  placeholder="000000"
                  placeholderTextColor={colors.mutedForeground}
                  value={code}
                  onChangeText={setCode}
                  autoCapitalize="characters"
                  autoFocus
                  keyboardType="default"
                />
              </View>
              <TouchableOpacity
                style={[styles.button, { backgroundColor: colors.primary, opacity: busy || !code ? 0.7 : 1 }]}
                onPress={handleVerifyTotp}
                disabled={busy || !code}
              >
                {busy ? (
                  <ActivityIndicator color={colors.primaryForeground} />
                ) : (
                  <>
                    <Feather name="shield" size={16} color={colors.primaryForeground} />
                    <Text style={[styles.buttonText, { color: colors.primaryForeground }]}>VERIFY</Text>
                  </>
                )}
              </TouchableOpacity>
              <TouchableOpacity onPress={cancelTotp} style={styles.forgotRow}>
                <Text style={[styles.forgotText, { color: colors.mutedForeground }]}>Use a different account</Text>
              </TouchableOpacity>
            </>
          )}
        </View>

        <View style={styles.legalRow}>
          <TouchableOpacity onPress={() => WebBrowser.openBrowserAsync(legalUrl("privacy"))}>
            <Text style={[styles.legalLink, { color: colors.mutedForeground }]}>Privacy</Text>
          </TouchableOpacity>
          <Text style={[styles.legalDot, { color: colors.mutedForeground }]}>·</Text>
          <TouchableOpacity onPress={() => WebBrowser.openBrowserAsync(legalUrl("terms"))}>
            <Text style={[styles.legalLink, { color: colors.mutedForeground }]}>Terms</Text>
          </TouchableOpacity>
          <Text style={[styles.legalDot, { color: colors.mutedForeground }]}>·</Text>
          <TouchableOpacity onPress={() => WebBrowser.openBrowserAsync(legalUrl("data-rights"))}>
            <Text style={[styles.legalLink, { color: colors.mutedForeground }]}>Your data rights</Text>
          </TouchableOpacity>
        </View>

        <Text style={[styles.footer, { color: colors.mutedForeground }]}>
          © {process.env.EXPO_PUBLIC_COMPANY_NAME ?? "Williams Council Security Group"}
        </Text>
      </View>
    </SafeAreaView>
  );
}

function legalUrl(slug: "privacy" | "terms" | "data-rights"): string {
  // Hosted on the admin-portal artifact under /admin-portal/<slug>.
  // Resolve from EXPO_PUBLIC_API_BASE_URL when available; fall back to the
  // production wcsg domain so the links work in built clients too.
  const base =
    (process.env.EXPO_PUBLIC_API_BASE_URL?.replace(/\/+$/, "")) ||
    (process.env.EXPO_PUBLIC_PORTAL_BASE_URL ?? "https://secureops.williamscouncilsecurity.com");
  // Strip trailing /api if the env var pointed at the API root.
  const root = base.replace(/\/api$/, "");
  return `${root}/admin-portal/${slug}`;
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  glow: {
    position: "absolute",
    top: "20%",
    alignSelf: "center",
    width: 300,
    height: 300,
    borderRadius: 150,
    backgroundColor: "#c9a84c",
    opacity: 0.07,
    transform: [{ scaleX: 1.6 }],
  },
  content: {
    flex: 1,
    justifyContent: "center",
    padding: 24,
    gap: 20,
  },
  logoWrap: {
    alignItems: "center",
  },
  logo: {
    width: 160,
    height: 160,
    borderRadius: 80,
  },
  brandBlock: {
    alignItems: "center",
    gap: 4,
  },
  brandName: {
    fontSize: 24,
    fontWeight: "800",
    letterSpacing: 4,
  },
  brandSub: {
    fontSize: 15,
    fontWeight: "600",
    letterSpacing: 6,
  },
  dividerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 8,
  },
  dividerLine: {
    flex: 1,
    height: 1,
    opacity: 0.5,
  },
  motto: {
    fontSize: 9,
    letterSpacing: 2,
    fontWeight: "600",
  },
  card: {
    padding: 22,
    borderRadius: 14,
    borderWidth: 1,
    gap: 14,
  },
  cardTitle: {
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 3,
    textAlign: "center",
    marginBottom: 4,
  },
  errorBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    padding: 12,
    borderRadius: 8,
    borderWidth: 1,
  },
  inputWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    height: 50,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 14,
  },
  input: {
    flex: 1,
    fontSize: 15,
  },
  button: {
    height: 50,
    justifyContent: "center",
    alignItems: "center",
    borderRadius: 8,
    flexDirection: "row",
    gap: 10,
    marginTop: 4,
  },
  buttonText: {
    fontWeight: "800",
    fontSize: 14,
    letterSpacing: 2,
  },
  forgotRow: {
    alignItems: "center",
    paddingVertical: 6,
    marginTop: 2,
  },
  forgotText: {
    fontSize: 12,
    letterSpacing: 1,
    textDecorationLine: "underline",
  },
  footer: {
    textAlign: "center",
    fontSize: 11,
    letterSpacing: 1,
  },
  legalRow: {
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    gap: 8,
    marginTop: 4,
  },
  legalLink: {
    fontSize: 11,
    letterSpacing: 0.5,
    textDecorationLine: "underline",
  },
  legalDot: {
    fontSize: 11,
    opacity: 0.5,
  },
});
