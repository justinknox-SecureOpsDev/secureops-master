import { Stack } from "expo-router";
import React from "react";

// Site-Manager-only Schedule section, mounted inside the employee shell so site managers keep
// the full employee experience (Home / My Shifts / Clock / Incidents / Chat)
// AND a scheduling tab. The screens themselves are the admin Shifts screens
// (re-exported below) — using a Stack (not flat Tabs) gives every push a fresh
// instance, matching app/(admin)/shifts/_layout.tsx. Screens render their own
// in-screen header, so hide the native one.
export default function ScheduleStackLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
