import { Stack } from "expo-router";
import React from "react";

// Nested admin routes render their own custom top bar (with a back button),
// so we hide the parent Tabs header here to avoid a duplicate header showing
// the literal route name (e.g. "shifts/edit/[id]") above each screen.
export default function ShiftsStackLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
