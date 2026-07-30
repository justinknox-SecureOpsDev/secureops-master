import { describe, expect, it } from "vitest";
import { buildAppIdentity } from "../appIdentity";

describe("buildAppIdentity", () => {
  it("returns null without a project id (Expo Go / misconfig)", () => {
    expect(
      buildAppIdentity({
        projectId: undefined,
        version: "1.0.2",
        iosBuildNumber: "12",
        androidVersionCode: 12,
        platformOS: "ios",
      }),
    ).toBeNull();
  });

  it("uses the iOS build number on iOS", () => {
    expect(
      buildAppIdentity({
        projectId: "proj-1",
        version: "1.0.2",
        iosBuildNumber: "14",
        androidVersionCode: 12,
        platformOS: "ios",
      }),
    ).toEqual({ projectId: "proj-1", appVersion: "1.0.2", buildNumber: "14", platform: "ios" });
  });

  it("uses the Android version code (stringified) on Android", () => {
    expect(
      buildAppIdentity({
        projectId: "proj-1",
        version: "1.0.2",
        iosBuildNumber: "14",
        androidVersionCode: 12,
        platformOS: "android",
      }),
    ).toEqual({ projectId: "proj-1", appVersion: "1.0.2", buildNumber: "12", platform: "android" });
  });

  it("tolerates missing version/build fields (web, dev clients)", () => {
    expect(
      buildAppIdentity({
        projectId: "proj-1",
        version: undefined,
        iosBuildNumber: undefined,
        androidVersionCode: undefined,
        platformOS: "web",
      }),
    ).toEqual({ projectId: "proj-1", appVersion: null, buildNumber: null, platform: "web" });
  });
});
