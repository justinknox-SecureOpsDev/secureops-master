import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
  useFonts,
} from "@expo-google-fonts/inter";
import { Feather, MaterialIcons, MaterialCommunityIcons, Ionicons, FontAwesome } from "@expo/vector-icons";
import { QueryClient, QueryClientProvider, focusManager, onlineManager } from "@tanstack/react-query";
import * as SplashScreen from "expo-splash-screen";
import NetInfo from "@react-native-community/netinfo";
import React, { useEffect } from "react";
import { AppState, Platform, type AppStateStatus } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { ErrorBoundary } from "@/components/ErrorBoundary";
import { AuthProvider } from "@/contexts/AuthContext";
import { ChatProvider } from "@/contexts/ChatContext";
import RootLayoutNav from "./RootLayoutNav";
import { setBaseUrl, setAuthTokenGetter } from "@workspace/api-client-react";
import { storage } from "@/utils/storage";
import { AUTH_TOKEN_KEY } from "@/contexts/AuthContext";

// Prevent the splash screen from auto-hiding before asset loading is complete.
SplashScreen.preventAutoHideAsync();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Treat data as stale after 10s so screens re-fetch when re-focused or
      // when the app comes back to the foreground. Keeps mobile + admin
      // portal in sync without needing a manual pull-to-refresh.
      staleTime: 10_000,
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
      refetchOnMount: true,
      retry: 1,
    },
  },
});

// React Query on native doesn't auto-detect focus/online events — wire them up.
onlineManager.setEventListener((setOnline) => {
  const unsub = NetInfo.addEventListener((state) => {
    setOnline(!!state.isConnected);
  });
  return () => unsub();
});

function onAppStateChange(status: AppStateStatus) {
  if (Platform.OS !== "web") {
    focusManager.setFocused(status === "active");
  }
}

// Configure API Client
setBaseUrl(`https://${process.env.EXPO_PUBLIC_DOMAIN}`);
setAuthTokenGetter(async () => {
  return await storage.get(AUTH_TOKEN_KEY);
});

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
  });

  // Eagerly load vector-icon fonts. On Android (especially in Expo Go with the
  // new architecture) the per-component lazy load from @expo/vector-icons
  // races first paint and tab bar icons render as empty boxes. Calling
  // loadFont() on mount registers the TTFs before any <Feather /> mounts.
  useEffect(() => {
    Promise.all([
      Feather.loadFont(),
      MaterialIcons.loadFont(),
      MaterialCommunityIcons.loadFont(),
      Ionicons.loadFont(),
      FontAwesome.loadFont(),
    ]).catch(() => {
      // Best effort — components will retry their own load.
    });
  }, []);

  useEffect(() => {
    if (fontsLoaded || fontError) {
      SplashScreen.hideAsync();
    }
  }, [fontsLoaded, fontError]);

  useEffect(() => {
    const sub = AppState.addEventListener("change", onAppStateChange);
    return () => sub.remove();
  }, []);

  if (!fontsLoaded && !fontError) return null;

  return (
    <SafeAreaProvider>
      <ErrorBoundary>
        <QueryClientProvider client={queryClient}>
          <GestureHandlerRootView>
            <KeyboardProvider>
              <AuthProvider>
                <ChatProvider>
                  <RootLayoutNav />
                </ChatProvider>
              </AuthProvider>
            </KeyboardProvider>
          </GestureHandlerRootView>
        </QueryClientProvider>
      </ErrorBoundary>
    </SafeAreaProvider>
  );
}
