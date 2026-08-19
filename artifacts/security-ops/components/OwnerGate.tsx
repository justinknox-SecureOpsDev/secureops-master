/**
 * Company-owner gating for the mobile admin app.
 *
 * Company owner is INDEPENDENT of role and of the pricing-tier feature
 * matrix — it only controls access to company-wide financial dashboards
 * (aggregate payroll/invoice totals). It never affects an officer's or site
 * manager's own-pay view.
 *
 * This is UI convenience only: the underlying admin payroll/invoice list
 * endpoints also enforce `requireCompanyOwner` server-side, so a non-owner
 * hitting this screen directly (deep link) still gets blocked by the API —
 * this component just avoids firing a request that's guaranteed to 403 and
 * shows a clear message instead of a generic error state.
 */

import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { Feather } from "@expo/vector-icons";
import { useColors } from "@/hooks/useColors";
import { useTopPad } from "@/hooks/useTopPad";
import { useAuth } from "@/contexts/AuthContext";

export function OwnerLockedNotice({ label = "financial dashboard" }: { label?: string }) {
  const colors = useColors();
  const topPad = useTopPad();
  return (
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: topPad + 24 }]}>
      <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <View style={[styles.iconWrap, { backgroundColor: colors.muted }]}>
          <Feather name="lock" size={26} color={colors.mutedForeground} />
        </View>
        <Text style={[styles.title, { color: colors.foreground }]}>
          Owner access required
        </Text>
        <Text style={[styles.body, { color: colors.mutedForeground }]}>
          This {label} is restricted to company owners. Ask an existing owner to grant you
          access from the admin portal.
        </Text>
      </View>
    </View>
  );
}

/** Renders children only when the signed-in user is a company owner. */
export function OwnerGate({ children, label }: { children: React.ReactNode; label?: string }) {
  const { user } = useAuth();
  if (!user?.isCompanyOwner) return <OwnerLockedNotice label={label} />;
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
