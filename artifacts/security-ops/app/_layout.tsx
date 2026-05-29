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
import { AppState, Platform, Text, TextInput, type AppStateStatus } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { ErrorBoundary } from "@/components/ErrorBoundary";
import { AccessibilityProvider } from "@/contexts/AccessibilityContext";
import { AuthProvider } from "@/contexts/AuthContext";
import { ChatProvider } from "@/contexts/ChatContext";
import { API_BASE_URL } from "@/utils/api";
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
// IMPORTANT: native only. On web, React Query already ships a reliable online
// manager (navigator.onLine + window "online"/"offline" events). Replacing it
// with @react-native-community/netinfo on web is both unnecessary and risky:
// netinfo's web layer can report `isConnected` falsy (transient reachability
// probe failures), which flips onlineManager to "offline" and PAUSES every
// mutation (default networkMode: "online"). A paused mutation's mutateAsync
// hangs forever — the clock-in/out button spins and no request is ever sent.
// Guarding to native mirrors the focusManager guard in onAppStateChange below.
if (Platform.OS !== "web") {
  onlineManager.setEventListener((setOnline) => {
    const unsub = NetInfo.addEventListener((state) => {
      setOnline(!!state.isConnected);
    });
    return () => unsub();
  });
}

function onAppStateChange(status: AppStateStatus) {
  if (Platform.OS !== "web") {
    focusManager.setFocused(status === "active");
  }
}

// Configure API Client. Use the same resolution as utils/api.ts so the
// generated client and hand-written fetches always agree on the origin
// (and so a bundle without EXPO_PUBLIC_DOMAIN still talks to the real
// API instead of "https://undefined").
setBaseUrl(API_BASE_URL.replace(/\/api$/, ""));
setAuthTokenGetter(async () => {
  return await storage.get(AUTH_TOKEN_KEY);
});

// Accessibility: honor the OS text-size setting (the multiplier RN applies is
// PixelRatio.getFontScale()) across the whole app, but cap it so very large
// system font sizes don't overflow the field-ops layouts (tab bars, badges,
// time-clock buttons). allowFontScaling defaults to true, so we only need to
// install the cap as a default prop on Text and TextInput.
const MAX_FONT_SCALE = 1.4;
type ScalableDefaults = { defaultProps?: { allowFontScaling?: boolean; maxFontSizeMultiplier?: number } };
const TextWithDefaults = Text as unknown as ScalableDefaults;
const TextInputWithDefaults = TextInput as unknown as ScalableDefaults;
TextWithDefaults.defaultProps = {
  ...TextWithDefaults.defaultProps,
  allowFontScaling: true,
  maxFontSizeMultiplier: MAX_FONT_SCALE,
};
TextInputWithDefaults.defaultProps = {
  ...TextInputWithDefaults.defaultProps,
  allowFontScaling: true,
  maxFontSizeMultiplier: MAX_FONT_SCALE,
};

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
              <AccessibilityProvider>
                <AuthProvider>
                  <ChatProvider>
                    <RootLayoutNav />
                  </ChatProvider>
                </AuthProvider>
              </AccessibilityProvider>
            </KeyboardProvider>
          </GestureHandlerRootView>
        </QueryClientProvider>
      </ErrorBoundary>
    </SafeAreaProvider>
  );
}
