import { Tabs } from "expo-router";
import { Feather } from "@expo/vector-icons";
import React from "react";
import { Platform, StyleSheet, View } from "react-native";
import { useColors } from "@/hooks/useColors";
import { BlurView } from "expo-blur";
import { TourProvider } from "@/contexts/TourContext";
import WelcomeTour from "@/components/WelcomeTour";
import { useChat } from "@/contexts/ChatContext";
import { useAuth } from "@/contexts/AuthContext";
import { useFeatures, isEnabled } from "@/hooks/useFeatures";
import { DemoBanner } from "@/components/DemoBanner";
import { TAB_HOME, TAB_MY_WORK, TAB_INCIDENTS, TAB_CHAT, TAB_PROFILE, TAB_MORE } from "@/constants/tabNames";
import { useAutoClockInWatcher } from "@/hooks/useAutoClockInWatcher";

export default function EmployeeLayout() {
  const colors = useColors();
  const isIOS = Platform.OS === "ios";
  const isWeb = Platform.OS === "web";
  // App-wide, foreground-only auto clock-in check — mounted here (not inside
  // the Clock screen) so it keeps running no matter which employee/site
  // manager tab is open. See hooks/useAutoClockInWatcher.ts.
  useAutoClockInWatcher();

  return (
    <TourProvider>
      <View style={styles.root}>
        <DemoBanner />
        <View style={styles.fill}>
          <EmployeeTabs colors={colors} isIOS={isIOS} isWeb={isWeb} />
        </View>
      </View>
      <WelcomeTour />
    </TourProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  fill: { flex: 1 },
});

function EmployeeTabs({ colors, isIOS, isWeb }: { colors: ReturnType<typeof useColors>; isIOS: boolean; isWeb: boolean }) {
  const { totalUnread } = useChat();
  const { user } = useAuth();
  const flags = useFeatures();
  // Site managers see a "More" tab instead of flat management tabs in the bar.
  // The management screens (Schedule, Approvals, Time) are hidden from the bar
  // for everyone and reached through the More screen for site managers, or via
  // router.push for any deep-link that needs them.
  const isSiteManager = user?.role === "site_manager";
  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.mutedForeground,
        headerShown: false,
        tabBarStyle: {
          position: "absolute",
          backgroundColor: isIOS ? "transparent" : colors.card,
          borderTopWidth: 1,
          borderTopColor: colors.border,
          elevation: 0,
          ...(isWeb ? { height: 60 } : {}),
        },
        tabBarBackground: () =>
          isIOS ? (
            <BlurView intensity={100} tint="dark" style={StyleSheet.absoluteFill} />
          ) : (
            <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.card }]} />
          ),
      }}
    >
      {/* ── Core tabs (visible for all employees) ──────────────────────── */}
      <Tabs.Screen
        name="home"
        options={{
          title: TAB_HOME,
          tabBarAccessibilityLabel: "Home tab",
          tabBarIcon: ({ color }) => <Feather name="home" size={22} color={color} />,
        }}
      />
      <Tabs.Screen
        name="my-work"
        options={{
          title: TAB_MY_WORK,
          tabBarAccessibilityLabel: "My shifts and clock-in tab",
          tabBarIcon: ({ color }) => <Feather name="briefcase" size={22} color={color} />,
        }}
      />
      <Tabs.Screen
        name="incidents"
        options={{
          title: TAB_INCIDENTS,
          href: isEnabled(flags, "incidents") ? undefined : null,
          tabBarAccessibilityLabel: "Incidents tab",
          tabBarIcon: ({ color }) => <Feather name="alert-triangle" size={22} color={color} />,
        }}
      />
      <Tabs.Screen
        name="chat"
        options={{
          title: TAB_CHAT,
          href: isEnabled(flags, "chat") ? undefined : null,
          tabBarAccessibilityLabel:
            totalUnread > 0
              ? `Team chat tab, ${totalUnread} unread message${totalUnread === 1 ? "" : "s"}`
              : "Team chat tab",
          tabBarBadge: totalUnread > 0 ? (totalUnread > 99 ? "99+" : totalUnread) : undefined,
          tabBarBadgeStyle: { backgroundColor: colors.primary, color: "#0c0a08", fontWeight: "700" },
          tabBarIcon: ({ color }) => <Feather name="message-circle" size={22} color={color} />,
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: TAB_PROFILE,
          tabBarAccessibilityLabel: "My profile tab",
          tabBarIcon: ({ color }) => <Feather name="user" size={22} color={color} />,
        }}
      />

      {/* ── Site manager overflow tab (visible only for site managers) ──── */}
      <Tabs.Screen
        name="more"
        options={{
          title: TAB_MORE,
          href: isSiteManager ? undefined : null,
          tabBarAccessibilityLabel: "More management tools tab",
          tabBarIcon: ({ color }) => <Feather name="grid" size={22} color={color} />,
        }}
      />

      {/* ── Hidden screens — reachable via router.push, not in tab bar ──── */}
      {/* shifts and clock are embedded inside My Work; kept here so deep-links
          (notifications, home screen shortcuts, etc.) still resolve correctly. */}
      <Tabs.Screen name="shifts" options={{ href: null }} />
      <Tabs.Screen name="clock" options={{ href: null }} />
      {/* radio is embedded in chat as a sub-tab when the feature is on */}
      <Tabs.Screen name="radio" options={{ href: null }} />
      {/* management screens — site managers reach these via the More tab */}
      <Tabs.Screen name="schedule" options={{ href: null, headerShown: false }} />
      <Tabs.Screen name="shift-approvals" options={{ href: null }} />
      <Tabs.Screen name="time-approval" options={{ href: null }} />
      <Tabs.Screen name="chat/[id]" options={{ href: null, headerShown: false }} />
      <Tabs.Screen name="chat/ai-bot" options={{ href: null, headerShown: false }} />
      <Tabs.Screen name="ops-plan" options={{ href: null, headerShown: false }} />
    </Tabs>
  );
}
