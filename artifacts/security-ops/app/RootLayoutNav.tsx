import { Stack, useRouter, useSegments } from "expo-router";
import React, { useEffect } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { View, ActivityIndicator } from "react-native";
import { useColors } from "@/hooks/useColors";
import { useNotifications } from "@/hooks/useNotifications";

export default function RootLayoutNav() {
  const { user, isLoading } = useAuth();
  const segments = useSegments();
  const router = useRouter();
  const colors = useColors();
  useNotifications();

  useEffect(() => {
    if (isLoading) return;

    const inAuthGroup = segments[0] === "(admin)" || segments[0] === "(employee)";
    
    if (!user) {
      if (inAuthGroup || segments[0] !== "login") {
        router.replace("/login");
      }
    } else {
      if (!inAuthGroup) {
        if (user.role === "admin") {
          router.replace("/(admin)/dashboard");
        } else {
          router.replace("/(employee)/home");
        }
      }
    }
  }, [user, isLoading, segments]);

  if (isLoading) {
    return (
      <View style={{ flex: 1, justifyContent: "center", alignItems: "center", backgroundColor: colors.background }}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="login" />
      <Stack.Screen name="(admin)" />
      <Stack.Screen name="(employee)" />
    </Stack>
  );
}
