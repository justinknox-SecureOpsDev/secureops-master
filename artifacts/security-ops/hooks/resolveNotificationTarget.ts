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
    // reminder all live on the shifts tab (admin or employee).
    case "shift_assigned":
    case "shift_reserved":
    case "shift_available":
    case "shift_vacancy_reminder":
    case "shift_reminder":
      return { pathname: `/${group}/shifts` };

    // Clock — forgot-to-clock-out nudge.
    case "forgot_clock_out":
      return { pathname: "/(employee)/clock" };

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
    case "emergency":
      return role === "admin" ? { pathname: "/(admin)/incidents" } : null;
    case "geofence_breach":
    case "missed_checkpoint":
      return role === "admin" ? { pathname: "/(admin)/live-map" } : null;
    case "high_risk_profile_change": {
      if (role !== "admin") return null;
      const id = str(d.employeeUserId);
      return id
        ? { pathname: "/(admin)/employees/[id]", params: { id } }
        : { pathname: "/(admin)/employees" };
    }

    default:
      return null;
  }
}
