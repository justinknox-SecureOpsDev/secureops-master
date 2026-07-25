import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  setupNotificationDeepLinking,
  type NotificationResponseLike,
  type NotificationsResponseModule,
  type DeepLinkPushTarget,
  type SetupNotificationDeepLinkingDeps,
} from "../notificationDeepLink";

function notif(data: unknown): NotificationResponseLike {
  return { notification: { request: { content: { data } } } };
}

type Harness = {
  push: ReturnType<typeof vi.fn>;
  getLast: ReturnType<typeof vi.fn>;
  addListener: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  /** Invokes the registered warm-tap listener (if any). */
  fireWarmTap: (data: unknown) => void;
  /** Resolves once the async setup IIFE has finished its awaits. */
  flush: () => Promise<void>;
};

function buildDeps(opts?: {
  platformOS?: string;
  isExpoGo?: boolean;
  role?: string | undefined;
  coldStart?: unknown;
  now?: () => number;
}): { deps: SetupNotificationDeepLinkingDeps; h: Harness } {
  const push = vi.fn<(t: DeepLinkPushTarget) => void>();
  const remove = vi.fn();
  let registered: ((r: NotificationResponseLike) => void) | undefined;

  const getLast = vi.fn<NotificationsResponseModule["getLastNotificationResponseAsync"]>(
    async () => (opts && "coldStart" in opts && opts.coldStart != null ? notif(opts.coldStart) : null),
  );
  const addListener = vi.fn<NotificationsResponseModule["addNotificationResponseReceivedListener"]>(
    (listener) => {
      registered = listener;
      return { remove };
    },
  );

  const loadNotifications = vi.fn(async () => ({
    getLastNotificationResponseAsync: getLast,
    addNotificationResponseReceivedListener: addListener,
  }));

  const deps: SetupNotificationDeepLinkingDeps = {
    platformOS: opts?.platformOS ?? "ios",
    isExpoGo: opts?.isExpoGo ?? false,
    getRole: () => opts?.role,
    push,
    loadNotifications,
    now: opts?.now,
  };

  return {
    deps,
    h: {
      push,
      getLast,
      addListener,
      remove,
      fireWarmTap: (data) => registered?.(notif(data)),
      // Two awaits in the IIFE (loadNotifications, getLast), so let the
      // microtask queue drain a couple of times.
      flush: async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      },
    },
  };
}

describe("setupNotificationDeepLinking", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("platform / Expo Go guards", () => {
    it("skips listener registration on web", async () => {
      const { deps, h } = buildDeps({ platformOS: "web" });
      const cleanup = setupNotificationDeepLinking(deps);
      await h.flush();
      expect(deps.loadNotifications).not.toHaveBeenCalled();
      expect(h.addListener).not.toHaveBeenCalled();
      expect(h.getLast).not.toHaveBeenCalled();
      expect(() => cleanup()).not.toThrow();
    });

    it("skips listener registration in Expo Go", async () => {
      const { deps, h } = buildDeps({ isExpoGo: true });
      const cleanup = setupNotificationDeepLinking(deps);
      await h.flush();
      expect(deps.loadNotifications).not.toHaveBeenCalled();
      expect(h.addListener).not.toHaveBeenCalled();
      expect(() => cleanup()).not.toThrow();
    });
  });

  describe("warm taps (response listener)", () => {
    it("registers a listener and pushes the resolved target on tap", async () => {
      const { deps, h } = buildDeps({ role: "employee" });
      setupNotificationDeepLinking(deps);
      await h.flush();

      expect(h.addListener).toHaveBeenCalledTimes(1);

      h.fireWarmTap({ type: "chat_message", roomId: 42, roomName: "Night Watch" });
      expect(h.push).toHaveBeenCalledTimes(1);
      const arg = h.push.mock.calls[0][0];
      expect(arg.pathname).toBe("/(employee)/chat/[id]");
      expect(arg.params.id).toBe("42");
      expect(arg.params.name).toBe("Night Watch");
      expect(typeof arg.params._hlTs).toBe("string");
    });

    it("routes a confirm_time_entry_reminder to the employee clock tab", async () => {
      const { deps, h } = buildDeps({ role: "employee" });
      setupNotificationDeepLinking(deps);
      await h.flush();

      h.fireWarmTap({ type: "confirm_time_entry_reminder", timeEntryId: 55 });
      expect(h.push).toHaveBeenCalledTimes(1);
      const arg = h.push.mock.calls[0][0];
      expect(arg.pathname).toBe("/(employee)/clock");
      expect(arg.params.timeEntryId).toBe("55");
    });

    it("routes an admin shift_claim_request to the approvals screen", async () => {
      const { deps, h } = buildDeps({ role: "admin" });
      setupNotificationDeepLinking(deps);
      await h.flush();

      h.fireWarmTap({ type: "shift_claim_request", shiftId: 9 });
      expect(h.push).toHaveBeenCalledTimes(1);
      expect(h.push.mock.calls[0][0].pathname).toBe("/(admin)/shift-approvals");
    });

    it("ignores shift_claim_request for non-admins", async () => {
      const { deps, h } = buildDeps({ role: "employee" });
      setupNotificationDeepLinking(deps);
      await h.flush();

      h.fireWarmTap({ type: "shift_claim_request", shiftId: 9 });
      expect(h.push).not.toHaveBeenCalled();
    });

    it("does not push for an unknown/unresolvable notification type", async () => {
      const { deps, h } = buildDeps({ role: "employee" });
      setupNotificationDeepLinking(deps);
      await h.flush();

      h.fireWarmTap({ type: "totally_unknown" });
      h.fireWarmTap({ roomId: "5" }); // no type
      expect(h.push).not.toHaveBeenCalled();
    });

    it("stamps a fresh highlight nonce on every tap", async () => {
      let t = 1000;
      const { deps, h } = buildDeps({ role: "admin", now: () => (t += 5) });
      setupNotificationDeepLinking(deps);
      await h.flush();

      h.fireWarmTap({ type: "shift_assigned", shiftId: 1 });
      h.fireWarmTap({ type: "shift_assigned", shiftId: 1 });
      expect(h.push).toHaveBeenCalledTimes(2);
      const first = h.push.mock.calls[0][0].params._hlTs;
      const second = h.push.mock.calls[1][0].params._hlTs;
      expect(first).not.toEqual(second);
    });
  });

  describe("cold-start taps (getLastNotificationResponseAsync)", () => {
    it("defers navigation by the cold-start delay then pushes", async () => {
      const { deps, h } = buildDeps({
        role: "admin",
        coldStart: { type: "emergency", incidentId: 7 },
      });
      setupNotificationDeepLinking(deps);
      await h.flush();

      // Nothing pushed until the 800ms defer elapses.
      expect(h.push).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(800);

      expect(h.push).toHaveBeenCalledTimes(1);
      const arg = h.push.mock.calls[0][0];
      expect(arg.pathname).toBe("/(admin)/incidents");
      expect(arg.params.incidentId).toBe("7");
    });

    it("does nothing when there is no last notification response", async () => {
      const { deps, h } = buildDeps({ role: "employee" });
      setupNotificationDeepLinking(deps);
      await h.flush();
      await vi.advanceTimersByTimeAsync(800);
      expect(h.push).not.toHaveBeenCalled();
    });

    it("does not fire the deferred cold-start nav after cleanup", async () => {
      const { deps, h } = buildDeps({
        role: "admin",
        coldStart: { type: "emergency", incidentId: 7 },
      });
      const cleanup = setupNotificationDeepLinking(deps);
      await h.flush();
      cleanup();
      await vi.advanceTimersByTimeAsync(800);
      expect(h.push).not.toHaveBeenCalled();
    });
  });

  describe("cleanup", () => {
    it("removes the response listener", async () => {
      const { deps, h } = buildDeps({ role: "employee" });
      const cleanup = setupNotificationDeepLinking(deps);
      await h.flush();
      cleanup();
      expect(h.remove).toHaveBeenCalledTimes(1);
    });
  });

  describe("role ref behaviour", () => {
    it("uses the latest role at tap time, not the role at setup time", async () => {
      let role: string | undefined = "employee";
      const push = vi.fn<(t: DeepLinkPushTarget) => void>();
      const remove = vi.fn();
      let registered: ((r: NotificationResponseLike) => void) | undefined;
      const loadNotifications = vi.fn(async () => ({
        getLastNotificationResponseAsync: vi.fn(async () => null),
        addNotificationResponseReceivedListener: (listener: (r: NotificationResponseLike) => void) => {
          registered = listener;
          return { remove };
        },
      }));

      setupNotificationDeepLinking({
        platformOS: "ios",
        isExpoGo: false,
        getRole: () => role,
        push,
        loadNotifications,
      });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      // emergency is admin-only — as an employee, the tap resolves to nothing.
      registered?.(notif({ type: "emergency", incidentId: 1 }));
      expect(push).not.toHaveBeenCalled();

      // Role is promoted to admin; the same payload now routes into the admin tab.
      role = "admin";
      registered?.(notif({ type: "emergency", incidentId: 1 }));
      expect(push).toHaveBeenCalledTimes(1);
      expect(push.mock.calls[0][0].pathname).toBe("/(admin)/incidents");
    });
  });

  describe("load failure", () => {
    it("swallows a failed expo-notifications import without throwing", async () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const push = vi.fn<(t: DeepLinkPushTarget) => void>();
      const cleanup = setupNotificationDeepLinking({
        platformOS: "ios",
        isExpoGo: false,
        getRole: () => "employee",
        push,
        loadNotifications: async () => {
          throw new Error("module unavailable");
        },
      });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(push).not.toHaveBeenCalled();
      expect(() => cleanup()).not.toThrow();
      expect(logSpy).toHaveBeenCalled();
    });
  });
});
