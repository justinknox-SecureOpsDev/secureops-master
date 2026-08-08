import React, { useState, useRef } from "react";
import {
  View, Text, TextInput, TouchableOpacity,
  StyleSheet, ActivityIndicator, Platform,
  type StyleProp, type TextStyle,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import Svg, {
  Defs,
  LinearGradient as SvgLinearGradient,
  Stop,
  Text as SvgText,
} from "react-native-svg";
import * as WebBrowser from "expo-web-browser";
import { useRouter } from "expo-router";
import { useAuth } from "@/contexts/AuthContext";
import { useOrg } from "@/contexts/OrgContext";
import { useColors } from "@/hooks/useColors";
import { SafeAreaView } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import { getApiBaseUrl } from "@/utils/api";
import { runSwitchOrgFlow } from "@/utils/orgBootstrap";
import { BrandLogo } from "@/components/BrandLogo";
import { useBrand } from "@/hooks/useFeatures";

async function postJson<T>(
  path: string,
  body: unknown,
  signal?: AbortSignal,
  timeoutMs = 30_000,
): Promise<T> {
  // Combine an internal deadline with any caller-supplied signal.
  const internal = new AbortController();
  const deadline = setTimeout(() => internal.abort(), timeoutMs);
  // Propagate caller abort → internal controller.
  signal?.addEventListener("abort", () => internal.abort(), { once: true });

  let res: Response;
  try {
    res = await fetch(`${getApiBaseUrl()}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: internal.signal,
    });
  } catch (e) {
    if (internal.signal.aborted) {
      // Distinguish user-cancel from timeout.
      const reason = signal?.aborted
        ? "Login cancelled."
        : "The server took too long to respond. Check your connection and try again.";
      throw new Error(reason);
    }
    const reason = e instanceof Error ? e.message : String(e);
    throw new Error(
      `Can't reach the server (${reason}). Check your internet connection and try again.`,
    );
  } finally {
    clearTimeout(deadline);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as any)?.message || `HTTP ${res.status}`);
  return data as T;
}

/** Metallic gradient stops matching the ACCESS SYSTEM button (see replit.md brand). */
const GOLD_STOPS = ["#f0d89a", "#c9a04a", "#aa8036"] as const;

/**
 * Gold metallic gradient brand text.
 *
 * MaskedView-based gradient text was removed because
 * @react-native-masked-view/masked-view is not linked in the App Store binary
 * — shipping it via OTA crashes the JS bridge.
 *
 * This variant uses react-native-svg (already linked in the binary — used by
 * LiveOfficerMap) on native: a plain RN <Text> sizes the layout, and an
 * absolutely-positioned <Svg> paints the same string with a left-to-right
 * gradient fill once measured. Until measurement completes (and on any
 * fallback path) the solid-gold text stays visible, so nothing can blank out
 * or crash. On web it's pure CSS background-clip gradient text.
 */
function GoldText({
  style,
  children,
  numberOfLines,
  adjustsFontSizeToFit,
  minimumFontScale,
}: {
  style: StyleProp<TextStyle>;
  children: React.ReactNode;
  /** Let long, variable-length tenant names wrap/shrink instead of clipping. */
  numberOfLines?: number;
  adjustsFontSizeToFit?: boolean;
  minimumFontScale?: number;
}) {
  const flat = StyleSheet.flatten(style) || {};
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);

  if (Platform.OS === "web") {
    return (
      <Text
        numberOfLines={numberOfLines}
        style={[
          style,
          { color: GOLD_STOPS[1] },
          {
            backgroundImage: `linear-gradient(90deg, ${GOLD_STOPS[0]}, ${GOLD_STOPS[1]}, ${GOLD_STOPS[2]})`,
            backgroundClip: "text",
            WebkitBackgroundClip: "text",
            WebkitTextFillColor: "transparent",
            color: "transparent",
          } as unknown as TextStyle,
        ]}
      >
        {children}
      </Text>
    );
  }

  // The native gradient below paints ONE non-wrapping SVG line. When the caller
  // asks the text to wrap or auto-shrink (long tenant company names), that path
  // clips, so render the solid-gold Text instead — it wraps/shrinks to fit and
  // stays on-brand (same gold used as the pre-measure fallback).
  if (numberOfLines != null || adjustsFontSizeToFit) {
    return (
      <Text
        numberOfLines={numberOfLines}
        adjustsFontSizeToFit={adjustsFontSizeToFit}
        minimumFontScale={minimumFontScale}
        style={[style, { color: GOLD_STOPS[1] }]}
      >
        {children}
      </Text>
    );
  }

  const gradientReady = size != null && size.w > 0 && size.h > 0 && typeof children === "string";
  const gradId = "goldTextGrad";
  const fontSize = typeof flat.fontSize === "number" ? flat.fontSize : 16;

  return (
    <View style={{ position: "relative" }}>
      <Text
        style={[style, { color: GOLD_STOPS[1], opacity: gradientReady ? 0 : 1 }]}
        onLayout={(e) => {
          const { width, height } = e.nativeEvent.layout;
          setSize({ w: width, h: height });
        }}
      >
        {children}
      </Text>
      {gradientReady ? (
        <Svg
          width={size.w}
          height={size.h}
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
          accessible={false}
          importantForAccessibility="no-hide-descendants"
        >
          <Defs>
            <SvgLinearGradient id={gradId} x1="0" y1="0" x2="1" y2="0">
              <Stop offset="0" stopColor={GOLD_STOPS[0]} />
              <Stop offset="0.5" stopColor={GOLD_STOPS[1]} />
              <Stop offset="1" stopColor={GOLD_STOPS[2]} />
            </SvgLinearGradient>
          </Defs>
          <SvgText
            fill={`url(#${gradId})`}
            x={size.w / 2}
            y={size.h / 2}
            textAnchor="middle"
            alignmentBaseline="central"
            fontSize={fontSize}
            fontWeight={typeof flat.fontWeight === "string" || typeof flat.fontWeight === "number" ? String(flat.fontWeight) : undefined}
            letterSpacing={typeof flat.letterSpacing === "number" ? flat.letterSpacing : undefined}
          >
            {children}
          </SvgText>
        </Svg>
      ) : null}
    </View>
  );
}

export default function LoginScreen() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [challengeToken, setChallengeToken] = useState<string | null>(null);
  const [code, setCode] = useState("");
  /** Abort controller for the in-flight login request — lets the user cancel. */
  const loginAbortRef = useRef<AbortController | null>(null);
  const { login: setAuthContext, logout } = useAuth();
  const { org, switchOrg } = useOrg();
  const colors = useColors();
  const brand = useBrand();
  const router = useRouter();
  // Platform fallback (no tenant brand fetched yet / neutral deployment) keeps
  // the fixed "SecureOps / COMMAND" lockup; a connected org shows ITS name.
  const isPlatformBrand = brand.companyName === "SecureOps Command";

  // Native-only: let an officer who connected to the wrong organization go
  // back to the connect screen. Log out FIRST (so the request hits the CURRENT
  // backend and clears the cached session) before forgetting the org + routing.
  const handleSwitchOrg = () =>
    runSwitchOrgFlow({
      logout,
      switchOrg,
      navigateToConnect: () => router.replace("/connect" as any),
    });

  const cancelLogin = () => {
    loginAbortRef.current?.abort();
    loginAbortRef.current = null;
  };

  const handleLogin = async () => {
    if (!email || !password) return;
    const controller = new AbortController();
    loginAbortRef.current = controller;
    setBusy(true); setError(null);
    try {
      const res = await postJson<{ token?: string; user?: any; needsTotp?: boolean; challengeToken?: string }>(
        "/auth/login",
        { email, password },
        controller.signal,
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

      <View style={styles.content}>
        {/* Connected org's logo — 3D: shadow, perspective tilt, shine overlay */}
        <View
          accessible
          accessibilityRole="image"
          accessibilityLabel={brand.companyName}
          style={styles.logoWrap}
        >
          <View style={styles.logo3dShell}>
            <BrandLogo size={180} />
            {/* Diagonal shine — light hits top-left, fades to transparent */}
            <LinearGradient
              colors={["rgba(255,248,220,0.28)", "rgba(255,248,220,0.06)", "transparent"]}
              start={{ x: 0.1, y: 0 }}
              end={{ x: 0.6, y: 0.55 }}
              style={StyleSheet.absoluteFill}
              pointerEvents="none"
            />
          </View>
        </View>

        {/* Connected org's brand (platform lockup until an org brand loads) */}
        <View style={styles.brandBlock}>
          {isPlatformBrand ? (
            <>
              <GoldText style={styles.brandName}>SecureOps</GoldText>
              <GoldText style={styles.brandSub}>COMMAND</GoldText>
            </>
          ) : (
            <GoldText
              style={[styles.brandName, styles.brandNameCompany]}
              numberOfLines={2}
              adjustsFontSizeToFit
              minimumFontScale={0.7}
            >
              {brand.companyName.toUpperCase()}
            </GoldText>
          )}
          <View style={styles.dividerRow}>
            <LinearGradient
              colors={["transparent", colors.primary]}
              start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
              style={styles.dividerLine}
            />
            <Text style={[styles.motto, { color: colors.mutedForeground }]}>
              {(brand.tagline || "SECURITY OPERATIONS PLATFORM").toUpperCase()}
            </Text>
            <LinearGradient
              colors={[colors.primary, "transparent"]}
              start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
              style={styles.dividerLine}
            />
          </View>
          {!!brand.companyLicense && (
            <Text style={[styles.licenseNumber, { color: colors.mutedForeground }]}>
              LIC # {brand.companyLicense}
            </Text>
          )}
        </View>

        {/* Login card — gradient top-edge highlight gives depth */}
        <LinearGradient
          colors={[colors.primary + "55", colors.primary + "18", "transparent"]}
          start={{ x: 0, y: 0 }} end={{ x: 0, y: 1 }}
          style={[styles.cardShell, { borderRadius: 15 }]}
        >
        <View style={[styles.card, { backgroundColor: colors.card }]}>
          <Text style={[styles.cardTitle, { color: colors.foreground }]}>COMMAND ACCESS</Text>
          {/*
           * Visible "no public sign-up" disclosure for App Store Review
           * (Guideline 5.1.1(v)). SecureOps Command is a workforce platform —
           * accounts are provisioned by each organization's HR after an
           * approved application. The reviewer is given a demo admin account
           * in App Review Notes.
           */}
          <Text style={[styles.cardSubtitle, { color: colors.mutedForeground }]}>
            Authorized personnel only. Accounts are issued by your organization's HR
            after onboarding — contact your supervisor for access.
          </Text>

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
                style={{ borderRadius: 8, overflow: "hidden", opacity: busy ? 0.8 : 1 }}
                onPress={handleLogin}
                disabled={busy}
              >
                <LinearGradient
                  colors={["#f0d89a", colors.primary, "#8a6020"]}
                  start={{ x: 0, y: 0 }} end={{ x: 0, y: 1 }}
                  style={styles.button}
                >
                  {busy ? (
                    <ActivityIndicator color={colors.primaryForeground} />
                  ) : (
                    <>
                      <Feather name="shield" size={16} color={colors.primaryForeground} />
                      <Text style={[styles.buttonText, { color: colors.primaryForeground }]}>ACCESS SYSTEM</Text>
                    </>
                  )}
                </LinearGradient>
              </TouchableOpacity>

              {busy ? (
                <TouchableOpacity onPress={cancelLogin} style={styles.forgotRow}>
                  <Text style={[styles.forgotText, { color: colors.mutedForeground }]}>
                    Cancel
                  </Text>
                </TouchableOpacity>
              ) : (
                <TouchableOpacity
                  onPress={() => router.push("/forgot-password")}
                  style={styles.forgotRow}
                >
                  <Text style={[styles.forgotText, { color: colors.mutedForeground }]}>
                    Forgot password?
                  </Text>
                </TouchableOpacity>
              )}
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
                style={{ borderRadius: 8, overflow: "hidden", opacity: busy || !code ? 0.7 : 1 }}
                onPress={handleVerifyTotp}
                disabled={busy || !code}
              >
                <LinearGradient
                  colors={["#f0d89a", colors.primary, "#8a6020"]}
                  start={{ x: 0, y: 0 }} end={{ x: 0, y: 1 }}
                  style={styles.button}
                >
                  {busy ? (
                    <ActivityIndicator color={colors.primaryForeground} />
                  ) : (
                    <>
                      <Feather name="shield" size={16} color={colors.primaryForeground} />
                      <Text style={[styles.buttonText, { color: colors.primaryForeground }]}>VERIFY</Text>
                    </>
                  )}
                </LinearGradient>
              </TouchableOpacity>
              <TouchableOpacity onPress={cancelTotp} style={styles.forgotRow}>
                <Text style={[styles.forgotText, { color: colors.mutedForeground }]}>Use a different account</Text>
              </TouchableOpacity>
            </>
          )}
        </View>
        </LinearGradient>

        {Platform.OS !== "web" && org && (
          <TouchableOpacity
            onPress={handleSwitchOrg}
            style={styles.switchOrgRow}
            accessibilityRole="button"
            accessibilityLabel={`Connected to ${org.name}. Switch organization`}
          >
            <Feather name="briefcase" size={12} color={colors.mutedForeground} />
            <Text style={[styles.switchOrgText, { color: colors.mutedForeground }]} numberOfLines={1}>
              Connected to <Text style={{ color: colors.foreground, fontWeight: "600" }}>{org.name}</Text>
            </Text>
            <Text style={[styles.switchOrgText, { color: colors.primary, fontWeight: "700" }]}>· Switch</Text>
          </TouchableOpacity>
        )}

        <View style={styles.legalRow}>
          <TouchableOpacity onPress={() => WebBrowser.openBrowserAsync(legalUrl("privacy"))}>
            <Text style={[styles.legalLink, { color: colors.mutedForeground }]}>Privacy</Text>
          </TouchableOpacity>
          <Text style={[styles.legalDot, { color: colors.mutedForeground }]}>·</Text>
          <TouchableOpacity onPress={() => WebBrowser.openBrowserAsync(legalUrl("terms"))}>
            <Text style={[styles.legalLink, { color: colors.mutedForeground }]}>Terms</Text>
          </TouchableOpacity>
          <Text style={[styles.legalDot, { color: colors.mutedForeground }]}>·</Text>
          <TouchableOpacity onPress={() => WebBrowser.openBrowserAsync(legalUrl("eula"))}>
            <Text style={[styles.legalLink, { color: colors.mutedForeground }]}>EULA</Text>
          </TouchableOpacity>
          <Text style={[styles.legalDot, { color: colors.mutedForeground }]}>·</Text>
          <TouchableOpacity onPress={() => WebBrowser.openBrowserAsync(legalUrl("data-rights"))}>
            <Text style={[styles.legalLink, { color: colors.mutedForeground }]}>Your data rights</Text>
          </TouchableOpacity>
        </View>

        <Text style={[styles.footer, { color: colors.mutedForeground }]}>
          {brand.companyName} · © {new Date().getFullYear()}
        </Text>
      </View>
    </SafeAreaView>
  );
}

function legalUrl(slug: "privacy" | "terms" | "eula" | "data-rights"): string {
  // Legal pages live under /admin-portal/<slug> on whichever backend is
  // currently selected. Resolve from the live API origin (which already
  // reflects the chosen organization on native, or same-origin on web), so
  // each customer's app shows that customer's policies.
  const root = getApiBaseUrl().replace(/\/api$/, "");
  return `${root}/admin-portal/${slug}`;
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  /* Gradient border shell that wraps the card */
  cardShell: {
    padding: 1,
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
  logo3dShell: {
    width: 180,
    height: 180,
    /* 3-D depth: perspective tilt + gold shadow */
    ...Platform.select({
      native: {
        shadowColor: "#c9a04a",
        shadowOffset: { width: 0, height: 14 },
        shadowOpacity: 0.55,
        shadowRadius: 22,
        elevation: 24,
      },
      web: {
        boxShadow: "0px 14px 22px 0px rgba(201,160,74,0.55)",
      },
    }),
    transform: [
      { perspective: 900 },
      { rotateX: "-7deg" },
    ],
    overflow: "hidden",
    borderRadius: 8,
  },
  brandBlock: {
    alignItems: "center",
    gap: 4,
  },
  brandName: {
    fontSize: 24,
    fontWeight: "800",
    letterSpacing: 4,
    textAlign: "center",
  },
  brandNameCompany: {
    // Long, variable-length tenant names: full width + tighter tracking so they
    // wrap to two centered lines (and shrink if needed) instead of clipping.
    alignSelf: "stretch",
    textAlign: "center",
    letterSpacing: 2,
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
  licenseNumber: {
    fontSize: 9,
    letterSpacing: 1,
    fontWeight: "500",
    textAlign: "center",
    opacity: 0.7,
    marginTop: 2,
  },
  card: {
    padding: 22,
    borderRadius: 14,
    gap: 14,
  },
  cardTitle: {
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 3,
    textAlign: "center",
    marginBottom: 4,
  },
  cardSubtitle: {
    fontSize: 11,
    lineHeight: 15,
    textAlign: "center",
    marginBottom: 4,
    paddingHorizontal: 4,
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
    flexWrap: "wrap",
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
  switchOrgRow: {
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    gap: 6,
    marginTop: 4,
  },
  switchOrgText: {
    fontSize: 12,
    letterSpacing: 0.3,
  },
});
