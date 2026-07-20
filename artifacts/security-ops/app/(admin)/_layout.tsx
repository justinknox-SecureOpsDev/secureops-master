import { Tabs } from "expo-router";
import { Feather } from "@expo/vector-icons";
import React from "react";
import { Platform, StyleSheet, View, useColorScheme } from "react-native";
import { useColors } from "@/hooks/useColors";
import { BlurView } from "expo-blur";
import { useChat } from "@/contexts/ChatContext";
import { useFeatures, isEnabled } from "@/hooks/useFeatures";
import { TourProvider } from "@/contexts/TourContext";

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
      <Tabs.Screen
        name="dashboard"
        options={{
          title: "Overview",
          headerTitle: `${process.env.EXPO_PUBLIC_COMPANY_SHORT_NAME ?? "SecureOps"} — Operations`,
          tabBarAccessibilityLabel: "Overview tab",
          tabBarIcon: ({ color }) => <Feather name="home" size={22} color={color} />,
        }}
      />
      <Tabs.Screen
        name="employees"
        options={{
          title: "Personnel",
          tabBarAccessibilityLabel: "Personnel tab",
          tabBarIcon: ({ color }) => <Feather name="users" size={22} color={color} />,
        }}
      />
      <Tabs.Screen
        name="shifts"
        options={{
          title: "Shifts",
          // The Shifts tab hosts a nested Stack whose screens render their own
          // in-screen headers — suppress the tab navigator's native header so
          // we don't double up.
          headerShown: false,
          tabBarAccessibilityLabel: "Shifts tab",
          tabBarIcon: ({ color }) => <Feather name="calendar" size={22} color={color} />,
        }}
      />
      <Tabs.Screen
        name="shift-approvals"
        options={{
          title: "Approvals",
          // The screen renders its own in-screen header/title, so suppress the
          // tab navigator's native header to avoid doubling up.
          headerShown: false,
          tabBarAccessibilityLabel: "Shift approvals tab",
          tabBarIcon: ({ color }) => <Feather name="user-check" size={22} color={color} />,
        }}
      />
      <Tabs.Screen
        name="live-map"
        options={{
          title: "Live Map",
          href: isEnabled(flags, "liveMap") ? undefined : null,
          tabBarAccessibilityLabel: "Live officer map tab",
          tabBarIcon: ({ color }) => <Feather name="map" size={22} color={color} />,
        }}
      />
      <Tabs.Screen
        name="incidents"
        options={{
          title: "Incidents",
          href: isEnabled(flags, "incidents") ? undefined : null,
          tabBarAccessibilityLabel: "Incidents tab",
          tabBarIcon: ({ color }) => <Feather name="alert-triangle" size={22} color={color} />,
        }}
      />
      <Tabs.Screen
        name="chat"
        options={{
          title: "Chat",
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
        name="radio"
        options={{
          title: "Radio",
          headerTitle: "Radio",
          href: isEnabled(flags, "radio") ? undefined : null,
          tabBarAccessibilityLabel: "Push to talk radio tab",
          tabBarIcon: ({ color }) => <Feather name="radio" size={22} color={color} />,
        }}
      />
      <Tabs.Screen
        name="clock"
        options={{
          title: "Clock",
          // The screen renders its own in-screen header/title, so suppress the
          // tab navigator's native header to avoid doubling up.
          headerShown: false,
          tabBarAccessibilityLabel: "Time clock tab",
          tabBarIcon: ({ color }) => <Feather name="clock" size={22} color={color} />,
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: "Profile",
          // The screen renders its own in-screen header/title, so suppress the
          // tab navigator's native header to avoid doubling up.
          headerShown: false,
          tabBarAccessibilityLabel: "My profile tab",
          tabBarIcon: ({ color }) => <Feather name="user" size={22} color={color} />,
        }}
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
