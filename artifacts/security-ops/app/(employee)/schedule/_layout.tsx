import { Redirect, Stack } from "expo-router";
import React from "react";
import { useAuth } from "@/contexts/AuthContext";

// Site-manager-only Schedule section, mounted inside the employee shell so site managers keep
// the full employee experience (Home / My Shifts / Clock / Incidents / Chat)
// AND a scheduling tab. The screens themselves are the admin Shifts screens
// (re-exported below) — using a Stack (not flat Tabs) gives every push a fresh
// instance, matching app/(admin)/shifts/_layout.tsx. Screens render their own
// in-screen header, so hide the native one.
//
// The Schedule tab is hidden from the tab bar for non-site managers (href: null), but
// the routes themselves (schedule + schedule/[id]) remain reachable via deep
// link / manual navigation. The admin Shifts screens expose assign/edit
// controls, so we gate the whole section here: any non-site-manager who lands inside is
// redirected to My Shifts before the admin screens mount. Site managers pass through.
export default function ScheduleStackLayout() {
  const { user, isLoading } = useAuth();

  if (isLoading) return null;
  if (user?.role !== "site_manager") {
    return <Redirect href="/(employee)/shifts" />;
  }

  return <Stack screenOptions={{ headerShown: false }} />;
}
