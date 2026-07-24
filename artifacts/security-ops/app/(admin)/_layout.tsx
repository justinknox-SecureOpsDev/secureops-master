import { Tabs } from "expo-router";
import { Feather } from "@expo/vector-icons";
import React from "react";
import { Platform, StyleSheet, View, useColorScheme } from "react-native";
import { useColors } from "@/hooks/useColors";
import { BlurView } from "expo-blur";
import { useChat } from "@/contexts/ChatContext";
import { useFeatures, isEnabled } from "@/hooks/useFeatures";
import { TourProvider } from "@/contexts/TourContext";
import {
  TAB_ADMIN_HOME,
  TAB_ADMIN_MY_WORK,
  TAB_ADMIN_PERSONNEL,
  TAB_ADMIN_SHIFTS,
  TAB_ADMIN_APPROVALS,
  TAB_ADMIN_LIVE_MAP,
  TAB_ADMIN_INCIDENTS,
  TAB_ADMIN_CHAT,
  TAB_ADMIN_RADIO,
  TAB_ADMIN_PROFILE,
  TAB_ADMIN_MORE,
} from "@/constants/tabNames";

export default function AdminLayout() {
  const colors = useColors();
  const colorScheme = useColorScheme();
  const isDark = colorScheme === "dark";
  const isIOS = Platform.OS === "ios";
  const isWeb = Platform.OS === "web";
  const { totalUnread } = useChat();
  const flags = useFeatures();

  return (
    // TourProvider is required because the shared profile screen (re-exported
    // from the employee shell) calls useTour(). The welcome tour never
    // auto-opens for admins (role gate inside the provider) and the replay
    // affordance is hidden for admins on the profile screen itself.
    <TourProvider>
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.mutedForeground,
        headerShown: true,
        headerStyle: {
          backgroundColor: isIOS ? "transparent" : colors.card,
        },
        headerTintColor: colors.foreground,
        headerTitleStyle: { fontWeight: "700", color: colors.foreground },
        headerBackground: () =>
          isIOS ? (
            <BlurView intensity={100} tint={isDark ? "dark" : "dark"} style={StyleSheet.absoluteFill} />
          ) : null,
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
      {/* ── Core tabs — mirrors the employee/site-manager shell ─────────────
          Home, My Work, Incidents, Chat, Profile, More. All management tools
          are reached through the More → Management screen, matching the site
          manager experience. */}
      <Tabs.Screen
        name="dashboard"
        options={{
          title: TAB_ADMIN_HOME,
          headerTitle: `${process.env.EXPO_PUBLIC_COMPANY_SHORT_NAME ?? "SecureOps"} — Operations`,
          tabBarAccessibilityLabel: "Home tab",
          tabBarIcon: ({ color }) => <Feather name="home" size={22} color={color} />,
        }}
      />
      <Tabs.Screen
        name="clock"
        options={{
          title: TAB_ADMIN_MY_WORK,
          // The screen renders its own in-screen header/title, so suppress the
          // tab navigator's native header to avoid doubling up.
          headerShown: false,
          tabBarAccessibilityLabel: "My work time clock tab",
          tabBarIcon: ({ color }) => <Feather name="briefcase" size={22} color={color} />,
        }}
      />
      <Tabs.Screen
        name="incidents"
        options={{
          title: TAB_ADMIN_INCIDENTS,
          href: isEnabled(flags, "incidents") ? undefined : null,
          tabBarAccessibilityLabel: "Incidents tab",
          tabBarIcon: ({ color }) => <Feather name="alert-triangle" size={22} color={color} />,
        }}
      />
      <Tabs.Screen
        name="chat"
        options={{
          title: TAB_ADMIN_CHAT,
          headerTitle: "Team Chat",
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
          title: TAB_ADMIN_PROFILE,
          // The screen renders its own in-screen header/title, so suppress the
          // tab navigator's native header to avoid doubling up.
          headerShown: false,
          tabBarAccessibilityLabel: "My profile tab",
          tabBarIcon: ({ color }) => <Feather name="user" size={22} color={color} />,
        }}
      />
      <Tabs.Screen
        name="more"
        options={{
          title: TAB_ADMIN_MORE,
          // The screen renders its own in-screen "Management" header.
          headerShown: false,
          tabBarAccessibilityLabel: "More management tools tab",
          tabBarIcon: ({ color }) => <Feather name="grid" size={22} color={color} />,
        }}
      />

      {/* ── Management screens — reached via the More tab, hidden from the bar.
          They keep their title props (rendered as native headers, and kept in
          sync with push-notification copy via the tabNames test suite). ──── */}
      <Tabs.Screen
        name="employees"
        options={{ href: null, title: TAB_ADMIN_PERSONNEL }}
      />
      <Tabs.Screen
        name="shifts"
        options={{
          href: null,
          title: TAB_ADMIN_SHIFTS,
          // The Shifts screens host a nested Stack whose screens render their
          // own in-screen headers — suppress the tab navigator's native header
          // so we don't double up.
          headerShown: false,
        }}
      />
      <Tabs.Screen
        name="shift-approvals"
        options={{
          href: null,
          title: TAB_ADMIN_APPROVALS,
          // The screen renders its own in-screen header/title.
          headerShown: false,
        }}
      />
      <Tabs.Screen
        name="live-map"
        options={{ href: null, title: TAB_ADMIN_LIVE_MAP }}
      />
      <Tabs.Screen
        name="radio"
        options={{ href: null, title: TAB_ADMIN_RADIO, headerTitle: "Radio" }}
      />

      {/* Hidden screens — accessible via router.push but not shown in tab bar */}
      <Tabs.Screen name="payroll" options={{ href: null, headerTitle: "Payroll" }} />
      <Tabs.Screen name="invoices" options={{ href: null, headerTitle: "Invoices" }} />
      <Tabs.Screen name="licenses" options={{ href: null, headerTitle: "Licences" }} />
      <Tabs.Screen name="license-approvals" options={{ href: null, headerTitle: "Licence Approvals" }} />
      <Tabs.Screen name="clients" options={{ href: null, headerTitle: "Clients" }} />
      <Tabs.Screen name="clients/[id]" options={{ href: null, headerTitle: "Client Sites" }} />
      <Tabs.Screen name="time-approval" options={{ href: null, headerTitle: "Time Approval" }} />
      <Tabs.Screen name="employees/[id]" options={{ href: null, headerTitle: "Employee Profile" }} />
      <Tabs.Screen name="employees/create" options={{ href: null, headerTitle: "Add Employee" }} />
      {/* shifts/* (list, detail, create, edit) live in a nested Stack — see
          app/(admin)/shifts/_layout.tsx — so they must NOT be registered as
          flat tab screens here (doing so reused a single instance and leaked
          an extra tab into the bar). */}
      <Tabs.Screen name="chat/[id]" options={{ href: null, headerShown: false }} />
    </Tabs>
    </TourProvider>
  );
}
