import { describe, it, expect } from "vitest";
import { resolveNotificationTarget } from "../resolveNotificationTarget";

describe("resolveNotificationTarget", () => {
  describe("guards on missing/invalid payloads", () => {
    it("returns null for null/undefined data", () => {
      expect(resolveNotificationTarget(null, "employee")).toBeNull();
      expect(resolveNotificationTarget(undefined, "admin")).toBeNull();
    });

    it("returns null for a payload with no type or kind", () => {
      expect(resolveNotificationTarget({}, "admin")).toBeNull();
      expect(resolveNotificationTarget({ roomId: "5" }, "employee")).toBeNull();
    });

    it("returns null when type is a non-string value", () => {
      expect(resolveNotificationTarget({ type: 123 }, "admin")).toBeNull();
      expect(resolveNotificationTarget({ type: { foo: "bar" } }, "admin")).toBeNull();
    });
  });

  describe("chat_message", () => {
    it("deep-links employees into their chat room with name", () => {
      expect(
        resolveNotificationTarget(
          { type: "chat_message", roomId: 42, roomName: "Night Watch" },
          "employee",
        ),
      ).toEqual({
        pathname: "/(employee)/chat/[id]",
        params: { id: "42", name: "Night Watch" },
      });
    });

    it("deep-links admins into the admin chat group", () => {
      expect(
        resolveNotificationTarget({ type: "chat_message", roomId: "7" }, "admin"),
      ).toEqual({
        pathname: "/(admin)/chat/[id]",
        params: { id: "7", name: "Chat" },
      });
    });

    it("defaults the room name to 'Chat' when roomName is absent", () => {
      const target = resolveNotificationTarget(
        { type: "chat_message", roomId: 1 },
        "employee",
      );
      expect(target?.params?.name).toBe("Chat");
    });

    it("returns null when roomId is missing", () => {
      expect(resolveNotificationTarget({ type: "chat_message" }, "employee")).toBeNull();
      expect(
        resolveNotificationTarget({ type: "chat_message", roomName: "x" }, "admin"),
      ).toBeNull();
    });
  });

  describe("shift lifecycle -> shifts tab", () => {
    const shiftTypes = [
      "shift_assigned",
      "shift_reserved",
      "shift_available",
      "shift_vacancy_reminder",
      "shift_reminder",
    ];

    for (const type of shiftTypes) {
      it(`routes ${type} to the employee shifts tab`, () => {
        expect(resolveNotificationTarget({ type }, "employee")).toEqual({
          pathname: "/(employee)/shifts",
        });
      });

      it(`routes ${type} to the admin shifts tab`, () => {
        expect(resolveNotificationTarget({ type }, "admin")).toEqual({
          pathname: "/(admin)/shifts",
        });
      });
    }
  });

  describe("clock / renewals", () => {
    it("routes forgot_clock_out to the employee clock screen", () => {
      expect(resolveNotificationTarget({ type: "forgot_clock_out" }, "employee")).toEqual({
        pathname: "/(employee)/clock",
      });
    });

    it("routes license_expiry_reminder to license-renewal", () => {
      expect(
        resolveNotificationTarget({ type: "license_expiry_reminder" }, "employee"),
      ).toEqual({ pathname: "/license-renewal" });
    });

    it("routes training_expiry_reminder to training-add", () => {
      expect(
        resolveNotificationTarget({ type: "training_expiry_reminder" }, "employee"),
      ).toEqual({ pathname: "/training-add" });
    });
  });

  describe("shift swaps -> swap-requests", () => {
    const swapTypes = [
      "swap-request",
      "swap-update",
      "swap-approved",
      "swap-rejected",
      "swap-cancelled",
    ];

    for (const type of swapTypes) {
      it(`routes ${type} to swap-requests for employees`, () => {
        expect(resolveNotificationTarget({ type }, "employee")).toEqual({
          pathname: "/swap-requests",
        });
      });

      it(`routes ${type} to swap-requests for admins`, () => {
        expect(resolveNotificationTarget({ type }, "admin")).toEqual({
          pathname: "/swap-requests",
        });
      });
    }

    it("routes swap-pending-approval to swap-requests for admins", () => {
      expect(
        resolveNotificationTarget({ type: "swap-pending-approval" }, "admin"),
      ).toEqual({ pathname: "/swap-requests" });
    });

    it("returns null for swap-pending-approval for non-admins", () => {
      expect(
        resolveNotificationTarget({ type: "swap-pending-approval" }, "employee"),
      ).toBeNull();
      expect(
        resolveNotificationTarget({ type: "swap-pending-approval" }, undefined),
      ).toBeNull();
    });
  });

  describe("shift_claim_request — admin and site_manager routing", () => {
    it("routes admins to the admin shift-approvals screen", () => {
      expect(resolveNotificationTarget({ type: "shift_claim_request" }, "admin")).toEqual({
        pathname: "/(admin)/shift-approvals",
      });
    });

    it("routes site managers to the employee shift-approvals screen (skips More)", () => {
      expect(
        resolveNotificationTarget({ type: "shift_claim_request" }, "site_manager"),
      ).toEqual({ pathname: "/(employee)/shift-approvals" });
    });

    it("returns null for plain employees (they never receive this notification)", () => {
      expect(resolveNotificationTarget({ type: "shift_claim_request" }, "employee")).toBeNull();
      expect(resolveNotificationTarget({ type: "shift_claim_request" }, undefined)).toBeNull();
    });
  });

  describe("time_entry_submitted — site_manager routing", () => {
    it("routes site managers to the employee time-approval screen (skips More)", () => {
      expect(
        resolveNotificationTarget({ type: "time_entry_submitted" }, "site_manager"),
      ).toEqual({ pathname: "/(employee)/time-approval" });
    });

    it("routes admins to the admin time-approval screen", () => {
      expect(resolveNotificationTarget({ type: "time_entry_submitted" }, "admin")).toEqual({
        pathname: "/(admin)/time-approval",
      });
    });

    it("returns null for plain employees", () => {
      expect(resolveNotificationTarget({ type: "time_entry_submitted" }, "employee")).toBeNull();
      expect(resolveNotificationTarget({ type: "time_entry_submitted" }, undefined)).toBeNull();
    });
  });

  describe("site_shift_created — site_manager schedule routing", () => {
    it("routes site managers to the schedule screen", () => {
      expect(
        resolveNotificationTarget({ type: "site_shift_created" }, "site_manager"),
      ).toEqual({ pathname: "/(employee)/schedule" });
    });

    it("carries shiftId and siteId params when present", () => {
      expect(
        resolveNotificationTarget(
          { type: "site_shift_created", shiftId: 42, siteId: "abc" },
          "site_manager",
        ),
      ).toEqual({
        pathname: "/(employee)/schedule",
        params: { shiftId: "42", siteId: "abc" },
      });
    });

    it("carries only siteId when shiftId is absent", () => {
      expect(
        resolveNotificationTarget(
          { type: "site_shift_created", siteId: "abc" },
          "site_manager",
        ),
      ).toEqual({
        pathname: "/(employee)/schedule",
        params: { siteId: "abc" },
      });
    });

    it("returns null for non-site-manager roles (they use different flows)", () => {
      expect(resolveNotificationTarget({ type: "site_shift_created" }, "admin")).toBeNull();
      expect(resolveNotificationTarget({ type: "site_shift_created" }, "employee")).toBeNull();
    });
  });

  describe("admin-only alerts", () => {
    it("routes emergency to admin incidents for admins, null otherwise", () => {
      expect(resolveNotificationTarget({ type: "emergency" }, "admin")).toEqual({
        pathname: "/(admin)/incidents",
      });
      expect(resolveNotificationTarget({ type: "emergency" }, "employee")).toBeNull();
      expect(resolveNotificationTarget({ type: "emergency" }, undefined)).toBeNull();
    });

    it("routes geofence_breach to the admin live map for admins, null otherwise", () => {
      expect(resolveNotificationTarget({ type: "geofence_breach" }, "admin")).toEqual({
        pathname: "/(admin)/live-map",
      });
      expect(resolveNotificationTarget({ type: "geofence_breach" }, "employee")).toBeNull();
    });

    it("routes missed_checkpoint to the admin live map for admins, null otherwise", () => {
      expect(resolveNotificationTarget({ type: "missed_checkpoint" }, "admin")).toEqual({
        pathname: "/(admin)/live-map",
      });
      expect(
        resolveNotificationTarget({ type: "missed_checkpoint" }, "employee"),
      ).toBeNull();
    });

    describe("high_risk_profile_change", () => {
      it("deep-links admins to the specific employee when employeeUserId is present", () => {
        expect(
          resolveNotificationTarget(
            { type: "high_risk_profile_change", employeeUserId: 99 },
            "admin",
          ),
        ).toEqual({
          pathname: "/(admin)/employees/[id]",
          params: { id: "99" },
        });
      });

      it("falls back to the employees list when employeeUserId is missing", () => {
        expect(
          resolveNotificationTarget({ type: "high_risk_profile_change" }, "admin"),
        ).toEqual({ pathname: "/(admin)/employees" });
      });

      it("returns null for non-admins regardless of employeeUserId", () => {
        expect(
          resolveNotificationTarget(
            { type: "high_risk_profile_change", employeeUserId: 99 },
            "employee",
          ),
        ).toBeNull();
        expect(
          resolveNotificationTarget({ type: "high_risk_profile_change" }, undefined),
        ).toBeNull();
      });
    });

    describe("scheduler_eligibility_skip", () => {
      it("deep-links admins to the shift so they can re-assign", () => {
        expect(
          resolveNotificationTarget(
            { type: "scheduler_eligibility_skip", shiftId: 77 },
            "admin",
          ),
        ).toEqual({
          pathname: "/(admin)/shifts",
          params: { shiftId: "77", filter: "upcoming" },
        });
      });

      it("falls back to the shifts list when shiftId is missing", () => {
        expect(
          resolveNotificationTarget({ type: "scheduler_eligibility_skip" }, "admin"),
        ).toEqual({ pathname: "/(admin)/shifts" });
      });

      it("returns null for non-admins", () => {
        expect(
          resolveNotificationTarget(
            { type: "scheduler_eligibility_skip", shiftId: 77 },
            "employee",
          ),
        ).toBeNull();
        expect(
          resolveNotificationTarget({ type: "scheduler_eligibility_skip" }, undefined),
        ).toBeNull();
      });
    });
  });

  describe("legacy `kind` key and unknown types", () => {
    it("honours the legacy `kind` key when `type` is absent", () => {
      expect(
        resolveNotificationTarget({ kind: "missed_checkpoint" }, "admin"),
      ).toEqual({ pathname: "/(admin)/live-map" });
    });

    it("prefers `type` over `kind` when both are present", () => {
      expect(
        resolveNotificationTarget(
          { type: "shift_reminder", kind: "emergency" },
          "employee",
        ),
      ).toEqual({ pathname: "/(employee)/shifts" });
    });

    it("returns null for unknown/legacy notification types", () => {
      expect(resolveNotificationTarget({ type: "totally_unknown" }, "admin")).toBeNull();
      expect(resolveNotificationTarget({ kind: "deprecated_thing" }, "employee")).toBeNull();
    });
  });
});
