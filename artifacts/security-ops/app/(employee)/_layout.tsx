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

export default function EmployeeLayout() {
  const colors = useColors();
  const isIOS = Platform.OS === "ios";
  const isWeb = Platform.OS === "web";

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
  // Site Managers get the full employee experience PLUS scheduling and approval
  // tabs. Schedule hosts a nested Stack (app/(employee)/schedule) re-exporting
  // the admin shift screens; the shift-approvals and time-approval tabs
  // re-export the admin approval screens. href:null keeps all three off the tab
  // bar for regular employees. The server enforces per-site scope for managers.
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
      <Tabs.Screen
        name="home"
        options={{
          title: "Home",
          tabBarAccessibilityLabel: "Home tab",
          tabBarIcon: ({ color }) => <Feather name="home" size={22} color={color} />,
        }}
      />
      <Tabs.Screen
        name="shifts"
        options={{
          title: "My Shifts",
          tabBarAccessibilityLabel: "My shifts tab",
          tabBarIcon: ({ color }) => <Feather name="calendar" size={22} color={color} />,
        }}
      />
      <Tabs.Screen
        name="schedule"
        options={{
          title: "Schedule",
          headerShown: false,
          href: isSiteManager ? undefined : null,
          tabBarAccessibilityLabel: "Schedule shifts tab",
          tabBarIcon: ({ color }) => <Feather name="clipboard" size={22} color={color} />,
        }}
      />
      <Tabs.Screen
        name="shift-approvals"
        options={{
          title: "Approvals",
          href: isSiteManager ? undefined : null,
          tabBarAccessibilityLabel: "Shift claim approvals tab",
          tabBarIcon: ({ color }) => <Feather name="user-check" size={22} color={color} />,
        }}
      />
      <Tabs.Screen
        name="time-approval"
        options={{
          title: "Time",
          href: isSiteManager ? undefined : null,
          tabBarAccessibilityLabel: "Time entry approvals tab",
          tabBarIcon: ({ color }) => <Feather name="check-square" size={22} color={color} />,
        }}
      />
      <Tabs.Screen
        name="clock"
        options={{
          title: "Clock",
          tabBarAccessibilityLabel: "Time clock tab",
          tabBarIcon: ({ color }) => <Feather name="clock" size={22} color={color} />,
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
          href: isEnabled(flags, "radio") ? undefined : null,
          tabBarAccessibilityLabel: "Push to talk radio tab",
          tabBarIcon: ({ color }) => <Feather name="radio" size={22} color={color} />,
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: "Profile",
          tabBarAccessibilityLabel: "My profile tab",
          tabBarIcon: ({ color }) => <Feather name="user" size={22} color={color} />,
        }}
      />
      <Tabs.Screen name="chat/[id]" options={{ href: null, headerShown: false }} />
    </Tabs>
  );
}
