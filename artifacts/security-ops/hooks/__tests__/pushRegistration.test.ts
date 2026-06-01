import { describe, it, expect, vi, afterEach } from "vitest";
import {
  registerForPushNotifications,
  type PushRegistrationModule,
  type RegisterForPushNotificationsDeps,
} from "../pushRegistration";

type Harness = {
  setNotificationHandler: ReturnType<typeof vi.fn>;
  setNotificationChannelAsync: ReturnType<typeof vi.fn>;
  getPermissionsAsync: ReturnType<typeof vi.fn>;
  requestPermissionsAsync: ReturnType<typeof vi.fn>;
  getExpoPushTokenAsync: ReturnType<typeof vi.fn>;
  loadNotifications: ReturnType<typeof vi.fn>;
  postPushToken: ReturnType<typeof vi.fn>;
};

function buildDeps(opts?: {
  platformOS?: string;
  isExpoGo?: boolean;
  projectId?: string | undefined;
  existingStatus?: string;
  requestedStatus?: string;
  tokenData?: { data: string };
  loadThrows?: boolean;
}): { deps: RegisterForPushNotificationsDeps; h: Harness } {
  const setNotificationHandler = vi.fn();
  const setNotificationChannelAsync = vi.fn(async () => undefined);
  const getPermissionsAsync = vi.fn(async () => ({
    status: opts?.existingStatus ?? "granted",
  }));
  const requestPermissionsAsync = vi.fn(async () => ({
    status: opts?.requestedStatus ?? "denied",
  }));
  const getExpoPushTokenAsync = vi.fn(async () =>
    opts && "tokenData" in opts ? opts.tokenData! : { data: "ExponentPushToken[abc123]" },
  );

  const module: PushRegistrationModule = {
    setNotificationHandler,
    setNotificationChannelAsync,
    AndroidImportance: { MAX: 5 },
    getPermissionsAsync,
    requestPermissionsAsync,
    getExpoPushTokenAsync,
  };

  const loadNotifications = vi.fn(async () => {
    if (opts?.loadThrows) throw new Error("module unavailable");
    return module;
  });
  const postPushToken = vi.fn(async () => {});

  const deps: RegisterForPushNotificationsDeps = {
    platformOS: opts?.platformOS ?? "ios",
    isExpoGo: opts?.isExpoGo ?? false,
    getProjectId: () => ("projectId" in (opts ?? {}) ? opts!.projectId : "proj-123"),
    loadNotifications,
    postPushToken,
  };

  return {
    deps,
    h: {
      setNotificationHandler,
      setNotificationChannelAsync,
      getPermissionsAsync,
      requestPermissionsAsync,
      getExpoPushTokenAsync,
      loadNotifications,
      postPushToken,
    },
  };
}

describe("registerForPushNotifications", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("environment guards", () => {
    it("skips registration entirely in Expo Go", async () => {
      const { deps, h } = buildDeps({ isExpoGo: true });
      const result = await registerForPushNotifications(deps);
      expect(result).toBeNull();
      expect(h.loadNotifications).not.toHaveBeenCalled();
      expect(h.getPermissionsAsync).not.toHaveBeenCalled();
      expect(h.getExpoPushTokenAsync).not.toHaveBeenCalled();
      expect(h.postPushToken).not.toHaveBeenCalled();
    });
  });

  describe("permission flow", () => {
    it("registers without prompting when permission is already granted", async () => {
      const { deps, h } = buildDeps({ existingStatus: "granted" });
      const result = await registerForPushNotifications(deps);
      expect(result).toBe("ExponentPushToken[abc123]");
      expect(h.getPermissionsAsync).toHaveBeenCalledTimes(1);
      expect(h.requestPermissionsAsync).not.toHaveBeenCalled();
      expect(h.getExpoPushTokenAsync).toHaveBeenCalledTimes(1);
      expect(h.postPushToken).toHaveBeenCalledWith("ExponentPushToken[abc123]");
    });

    it("prompts then registers when permission is granted on request", async () => {
      const { deps, h } = buildDeps({
        existingStatus: "undetermined",
        requestedStatus: "granted",
      });
      const result = await registerForPushNotifications(deps);
      expect(result).toBe("ExponentPushToken[abc123]");
      expect(h.getPermissionsAsync).toHaveBeenCalledTimes(1);
      expect(h.requestPermissionsAsync).toHaveBeenCalledTimes(1);
      expect(h.getExpoPushTokenAsync).toHaveBeenCalledTimes(1);
      expect(h.postPushToken).toHaveBeenCalledWith("ExponentPushToken[abc123]");
    });

    it("early-returns without fetching a token when permission is denied", async () => {
      const { deps, h } = buildDeps({
        existingStatus: "undetermined",
        requestedStatus: "denied",
      });
      const result = await registerForPushNotifications(deps);
      expect(result).toBeNull();
      expect(h.requestPermissionsAsync).toHaveBeenCalledTimes(1);
      expect(h.getExpoPushTokenAsync).not.toHaveBeenCalled();
      expect(h.postPushToken).not.toHaveBeenCalled();
    });
  });

  describe("EAS project id", () => {
    it("early-returns when the project id is missing", async () => {
      const { deps, h } = buildDeps({ projectId: undefined });
      const result = await registerForPushNotifications(deps);
      expect(result).toBeNull();
      expect(h.getExpoPushTokenAsync).not.toHaveBeenCalled();
      expect(h.postPushToken).not.toHaveBeenCalled();
    });
  });

  describe("android channels", () => {
    it("configures the default + emergency channels on android", async () => {
      const { deps, h } = buildDeps({ platformOS: "android" });
      await registerForPushNotifications(deps);
      expect(h.setNotificationChannelAsync).toHaveBeenCalledTimes(2);
      expect(h.setNotificationChannelAsync.mock.calls[0][0]).toBe("default");
      expect(h.setNotificationChannelAsync.mock.calls[1][0]).toBe("emergency");
    });

    it("does not configure channels on ios", async () => {
      const { deps, h } = buildDeps({ platformOS: "ios" });
      await registerForPushNotifications(deps);
      expect(h.setNotificationChannelAsync).not.toHaveBeenCalled();
    });
  });

  describe("token POST", () => {
    it("POSTs the resolved token to the backend on success", async () => {
      const { deps, h } = buildDeps({ tokenData: { data: "ExponentPushToken[xyz]" } });
      const result = await registerForPushNotifications(deps);
      expect(result).toBe("ExponentPushToken[xyz]");
      expect(h.postPushToken).toHaveBeenCalledTimes(1);
      expect(h.postPushToken).toHaveBeenCalledWith("ExponentPushToken[xyz]");
    });

    it("does not POST when the resolved token is empty", async () => {
      const { deps, h } = buildDeps({ tokenData: { data: "" } });
      const result = await registerForPushNotifications(deps);
      expect(result).toBeNull();
      expect(h.postPushToken).not.toHaveBeenCalled();
    });
  });

  describe("failure handling", () => {
    it("swallows a failed expo-notifications import and returns null", async () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const { deps, h } = buildDeps({ loadThrows: true });
      const result = await registerForPushNotifications(deps);
      expect(result).toBeNull();
      expect(h.postPushToken).not.toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalled();
    });
  });
});
