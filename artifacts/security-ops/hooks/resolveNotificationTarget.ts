export type NavTarget = { pathname: string; params?: Record<string, string> };

// Map a push notification's `data` payload + the recipient's role to a deep-link
// target. Returns null for unknown/legacy notifications so the caller falls back
// to the default landing screen. Senders set `data.type`; the legacy missed-
// patrol push used `data.kind`, so we honour that too.
export function resolveNotificationTarget(
  data: unknown,
  role: string | undefined,
): NavTarget | null {
  const d = data as Record<string, unknown> | null | undefined;
  if (!d) return null;
  const type =
    typeof d.type === "string" ? d.type : typeof d.kind === "string" ? d.kind : undefined;
  if (!type) return null;

  const group = role === "admin" ? "(admin)" : "(employee)";
  const str = (v: unknown): string | undefined => (v == null ? undefined : String(v));

  switch (type) {
    // Chat — deep-link into the room so the header can be labelled.
    case "chat_message": {
      if (!d.roomId) return null;
      return {
        pathname: `/${group}/chat/[id]`,
        params: { id: String(d.roomId), name: d.roomName ? String(d.roomName) : "Chat" },
      };
    }

    // Shift lifecycle — assignment, reservation, open vacancy, pre-shift
    // reminder all live on the shifts tab (admin or employee). Carry the
    // shiftId so the list can scroll to + highlight the exact shift, plus a
    // filter hint pointing at the tab the shift actually lives under.
    case "shift_assigned":
    case "shift_reserved":
    case "shift_reminder": {
      const shiftId = str(d.shiftId);
      return {
        pathname: `/${group}/shifts`,
        params: shiftId ? { shiftId, filter: "upcoming" } : undefined,
      };
    }
    case "shift_available":
    case "shift_vacancy_reminder": {
      const shiftId = str(d.shiftId);
      return {
        pathname: `/${group}/shifts`,
        params: shiftId ? { shiftId, filter: "available" } : undefined,
      };
    }

    // Clock — forgot-to-clock-out nudge. Highlight the open entry on the clock
    // tab's recent-entries list.
    case "forgot_clock_out": {
      const timeEntryId = str(d.timeEntryId);
      return {
        pathname: "/(employee)/clock",
        params: timeEntryId ? { timeEntryId } : undefined,
      };
    }

    // License / training renewal.
    case "license_expiry_reminder":
      return { pathname: "/license-renewal" };
    case "training_expiry_reminder":
      return { pathname: "/training-add" };

    // Shift swaps — request, accept/decline, approval/rejection, cancellation.
    case "swap-request":
    case "swap-update":
    case "swap-approved":
    case "swap-rejected":
    case "swap-cancelled":
      return { pathname: "/swap-requests" };
    // Admin gets pinged when an officer-to-officer swap needs approval.
    case "swap-pending-approval":
      return role === "admin" ? { pathname: "/swap-requests" } : null;

    // Admin-only alerts. These are only sent to admins; guard on role so a
    // stray payload never routes a non-admin into the admin tab group.
    case "emergency": {
      if (role !== "admin") return null;
      const incidentId = str(d.incidentId);
      return {
        pathname: "/(admin)/incidents",
        params: incidentId ? { incidentId } : undefined,
      };
    }
    case "geofence_breach": {
      if (role !== "admin") return null;
      // Center the live map on the breaching officer.
      const userId = str(d.userId);
      const siteId = str(d.siteId);
      const params: Record<string, string> = {};
      if (userId) params.userId = userId;
      if (siteId) params.siteId = siteId;
      return {
        pathname: "/(admin)/live-map",
        params: Object.keys(params).length ? params : undefined,
      };
    }
    case "missed_checkpoint": {
      if (role !== "admin") return null;
      // The missed-checkpoint payload carries the time entry + site (no userId);
      // the map resolves the officer from the active time entry.
      const timeEntryId = str(d.timeEntryId);
      const siteId = str(d.siteId);
      const params: Record<string, string> = {};
      if (timeEntryId) params.timeEntryId = timeEntryId;
      if (siteId) params.siteId = siteId;
      return {
        pathname: "/(admin)/live-map",
        params: Object.keys(params).length ? params : undefined,
      };
    }
    case "high_risk_profile_change": {
      if (role !== "admin") return null;
      const id = str(d.employeeUserId);
      return id
        ? { pathname: "/(admin)/employees/[id]", params: { id } }
        : { pathname: "/(admin)/employees" };
    }

    // The scheduler tried to roster an under-licensed officer; the slot may be
    // short-staffed. Deep-link the admin to the shift so they can assign a
    // qualified officer.
    case "scheduler_eligibility_skip": {
      if (role !== "admin") return null;
      const shiftId = str(d.shiftId);
      return {
        pathname: "/(admin)/shifts",
        params: shiftId ? { shiftId, filter: "upcoming" } : undefined,
      };
    }

    default:
      return null;
  }
}
