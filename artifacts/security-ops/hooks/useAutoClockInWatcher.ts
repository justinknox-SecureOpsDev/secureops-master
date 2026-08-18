import { useEffect, useRef } from "react";
import { AppState } from "react-native";
import * as Location from "expo-location";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { useLocationConsent } from "@/contexts/LocationConsentContext";
import {
  useAutoClockIn,
  useGetActiveTimeEntry,
  getGetActiveTimeEntryQueryKey,
  getGetMyClockInShiftsQueryKey,
  getGetEmployeeDashboardSummaryQueryKey,
  getGetShiftsQueryKey,
} from "@workspace/api-client-react";

// How often to silently re-check while the app is in the foreground and the
// officer isn't already clocked in. There is deliberately NO background
// timer or background-location watcher — see .agents/memory/mobile-location-
// foreground-only.md. This can only ever fire while a human has the app
// open, which is why the site-level toggle defaults OFF: it's a convenience
// for sites that opt in, not a guarantee an officer is never late to punch.
const CHECK_INTERVAL_MS = 2 * 60 * 1000;

// Mounted once, app-wide (in the employee/site_manager tab layout), so the
// check keeps running no matter which tab is open — not just the Clock
// screen. Silent by design: on a match the server sends a push notification
// and the clocked-in state simply appears next time a screen reads the
// active time entry; there is nothing for this hook to render.
export function useAutoClockInWatcher() {
  const { user } = useAuth();
  const { ensureLocationPermission } = useLocationConsent();
  const queryClient = useQueryClient();
  const autoClockInMutation = useAutoClockIn();

  // Only employees and site managers clock in/out at all; admins and client
  // portal users never reach this layout, but guard anyway.
  const eligibleRole = user?.role === "employee" || user?.role === "site_manager";

  const { data: activeEntry } = useGetActiveTimeEntry({
    query: { queryKey: getGetActiveTimeEntryQueryKey(), enabled: eligibleRole },
  });
  const isClockedIn = !!activeEntry;

  // Refs so the interval callback always sees the latest values without
  // needing to be torn down and rebuilt on every render.
  const isClockedInRef = useRef(isClockedIn);
  isClockedInRef.current = isClockedIn;
  const inFlightRef = useRef(false);

  useEffect(() => {
    if (!eligibleRole) return;

    const check = async () => {
      if (inFlightRef.current) return;
      if (isClockedInRef.current) return;
      if (AppState.currentState !== "active") return;
      inFlightRef.current = true;
      try {
        const granted = await ensureLocationPermission({ silent: true });
        if (!granted) return;
        const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        const result: any = await autoClockInMutation.mutateAsync({
          data: { lat: loc.coords.latitude, lng: loc.coords.longitude },
        });
        if (result?.triggered) {
          queryClient.invalidateQueries({ queryKey: getGetActiveTimeEntryQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetMyClockInShiftsQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetEmployeeDashboardSummaryQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetShiftsQueryKey() });
        }
      } catch {
        // Best-effort background convenience check — never surface errors.
      } finally {
        inFlightRef.current = false;
      }
    };

    check();
    const interval = setInterval(check, CHECK_INTERVAL_MS);
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") check();
    });
    return () => {
      clearInterval(interval);
      sub.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eligibleRole]);
}
