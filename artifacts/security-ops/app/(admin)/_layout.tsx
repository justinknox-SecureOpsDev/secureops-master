import { Tabs } from "expo-router";
import { Feather } from "@expo/vector-icons";
import React from "react";
import { Platform, StyleSheet, View, useColorScheme } from "react-native";
import { useColors } from "@/hooks/useColors";
import { BlurView } from "expo-blur";

export default function AdminLayout() {
  const colors = useColors();
  const colorScheme = useColorScheme();
  const isDark = colorScheme === "dark";
  const isIOS = Platform.OS === "ios";
  const isWeb = Platform.OS === "web";

  return (
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
          headerTitle: "WCSG — Operations",
          tabBarIcon: ({ color }) => <Feather name="home" size={22} color={color} />,
        }}
      />
      <Tabs.Screen
        name="employees"
        options={{
          title: "Personnel",
          tabBarIcon: ({ color }) => <Feather name="users" size={22} color={color} />,
        }}
      />
      <Tabs.Screen
        name="shifts"
        options={{
          title: "Shifts",
          tabBarIcon: ({ color }) => <Feather name="calendar" size={22} color={color} />,
        }}
      />
      <Tabs.Screen
        name="incidents"
        options={{
          title: "Incidents",
          tabBarIcon: ({ color }) => <Feather name="alert-triangle" size={22} color={color} />,
        }}
      />

      {/* Hidden screens — accessible via router.push but not shown in tab bar */}
      <Tabs.Screen name="payroll" options={{ href: null, headerTitle: "Payroll" }} />
      <Tabs.Screen name="invoices" options={{ href: null, headerTitle: "Invoices" }} />
      <Tabs.Screen name="licenses" options={{ href: null, headerTitle: "Licences" }} />
      <Tabs.Screen name="employees/[id]" options={{ href: null, headerTitle: "Employee Profile" }} />
      <Tabs.Screen name="employees/create" options={{ href: null, headerTitle: "Add Employee" }} />
      <Tabs.Screen name="shifts/[id]" options={{ href: null, headerTitle: "Shift Details" }} />
      <Tabs.Screen name="shifts/create" options={{ href: null, headerTitle: "Create Shift" }} />
    </Tabs>
  );
}
