import { Stack } from "expo-router";
import React from "react";

// Nested stack for the admin Shifts section. Using a Stack (not flat Tabs
// screens) means every router.push to a shift detail / create / edit route
// mounts a FRESH screen instance. Flat tab screens are reused/never remounted,
// which caused opening one shift to flash a previously-viewed shift and the
// edit form to keep a prior shift's prefilled values ("switches to a different
// shift"). Each screen renders its own in-screen header, so hide the native one.
export default function ShiftsStackLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
