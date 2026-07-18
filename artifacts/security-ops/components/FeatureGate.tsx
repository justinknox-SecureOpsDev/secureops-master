/**
 * Pricing-tier feature gating for the mobile app.
 *
 * Locked features are hidden at their entry points — a gated tab drops its
 * `href` and gated menu actions aren't rendered — so a tier-locked feature has
 * no visible entry point. `FeatureGate` is the backstop for a screen still
 * reached directly (a deep link / router.push): it renders a neutral
 * "not available" state instead of the feature, with no purchase or upgrade
 * steering.
 *
 * Feature state comes from GET /api/brand (see hooks/useFeatures.ts) — all keys
 * default to ENABLED, so newer features appear automatically on older plans.
 */

import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { Feather } from "@expo/vector-icons";
import { useColors } from "@/hooks/useColors";
import { useTopPad } from "@/hooks/useTopPad";
import { useFeature, type FeatureKey } from "@/hooks/useFeatures";

/**
 * Neutral placeholder shown when a tier-gated screen is reached directly even
 * though its entry point is hidden. Deliberately free of any upgrade /
 * subscription / plan wording so it doesn't steer the user toward a purchase.
 */
export function FeatureUnavailable() {
  const colors = useColors();
  const topPad = useTopPad();
  return (
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: topPad + 24 }]}>
      <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <View style={[styles.iconWrap, { backgroundColor: colors.muted }]}>
          <Feather name="info" size={26} color={colors.mutedForeground} />
        </View>
        <Text style={[styles.title, { color: colors.foreground }]}>
          Not available
        </Text>
        <Text style={[styles.body, { color: colors.mutedForeground }]}>
          This feature isn't available on your account. If you think you should
          have access, contact your administrator.
        </Text>
      </View>
    </View>
  );
}

/** Renders children when the feature is enabled, otherwise a neutral notice. */
export function FeatureGate({
  feature,
  children,
}: {
  feature: FeatureKey;
  children: React.ReactNode;
}) {
  const enabled = useFeature(feature);
  if (!enabled) return <FeatureUnavailable />;
  return <>{children}</>;
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingHorizontal: 24, alignItems: "center" },
  card: {
    width: "100%",
    maxWidth: 440,
    borderWidth: 1,
    borderRadius: 16,
    padding: 28,
    alignItems: "center",
  },
  iconWrap: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 16,
  },
  title: { fontSize: 17, fontWeight: "700", textAlign: "center" },
  body: { fontSize: 14, lineHeight: 20, textAlign: "center", marginTop: 8 },
});
