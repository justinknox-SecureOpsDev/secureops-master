import { Stack } from "expo-router";
import React from "react";

// Read-only protection-package (ops plan) section for assigned officers.
// Mounted inside the employee shell but hidden from the tab bar (href: null on
// the parent Tabs.Screen). Uses a Stack (not flat Tabs) so every push of
// ops-plan/[id] gets a fresh instance and never reuses a prior shift's screen.
// The screen renders its own in-screen header, so hide the native one.
export default function OpsPlanStackLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
