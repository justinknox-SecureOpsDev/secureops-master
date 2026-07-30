import { describe, expect, it, vi } from "vitest";
import { resolveLocationAccess, type LocationGateDeps } from "../locationConsent";

/**
 * These assertions encode a store-compliance rule, not just behaviour:
 * Google Play rejected this app because location collection began without a
 * prominent in-app disclosure. The critical invariant is that on Android the OS
 * permission prompt is NEVER reached before the user affirmatively agrees.
 */
function makeDeps(overrides: Partial<LocationGateDeps> = {}) {
  const deps: LocationGateDeps = {
    platform: "android",
    silent: false,
    hasAccepted: vi.fn(async () => false),
    recordAccepted: vi.fn(async () => {}),
    askForConsent: vi.fn(async () => true),
    getCurrentStatus: vi.fn(async () => "granted"),
    requestPermission: vi.fn(async () => "granted"),
    ...overrides,
  };
  return deps;
}

describe("resolveLocationAccess — Android prominent disclosure", () => {
  it("shows the disclosure before the OS prompt on first use", async () => {
    const deps = makeDeps();
    const ok = await resolveLocationAccess(deps);

    expect(ok).toBe(true);
    expect(deps.askForConsent).toHaveBeenCalledTimes(1);
    expect(deps.recordAccepted).toHaveBeenCalledTimes(1);
    expect(deps.requestPermission).toHaveBeenCalledTimes(1);
  });

  it("never reaches the OS prompt when the user declines the disclosure", async () => {
    const deps = makeDeps({ askForConsent: vi.fn(async () => false) });
    const ok = await resolveLocationAccess(deps);

    expect(ok).toBe(false);
    expect(deps.requestPermission).not.toHaveBeenCalled();
    expect(deps.getCurrentStatus).not.toHaveBeenCalled();
    expect(deps.recordAccepted).not.toHaveBeenCalled();
  });

  it("does not re-show the disclosure once accepted", async () => {
    const deps = makeDeps({ hasAccepted: vi.fn(async () => true) });
    const ok = await resolveLocationAccess(deps);

    expect(ok).toBe(true);
    expect(deps.askForConsent).not.toHaveBeenCalled();
    expect(deps.requestPermission).toHaveBeenCalledTimes(1);
  });

  it("returns false when the OS permission is refused even after agreeing", async () => {
    const deps = makeDeps({ requestPermission: vi.fn(async () => "denied") });
    expect(await resolveLocationAccess(deps)).toBe(false);
  });
});

describe("resolveLocationAccess — silent mode", () => {
  it("collects nothing and shows nothing when the disclosure has not been accepted", async () => {
    const deps = makeDeps({ silent: true, hasAccepted: vi.fn(async () => false) });
    const ok = await resolveLocationAccess(deps);

    expect(ok).toBe(false);
    expect(deps.askForConsent).not.toHaveBeenCalled();
    expect(deps.requestPermission).not.toHaveBeenCalled();
    expect(deps.getCurrentStatus).not.toHaveBeenCalled();
  });

  it("uses the already-granted permission without prompting", async () => {
    const deps = makeDeps({
      silent: true,
      hasAccepted: vi.fn(async () => true),
      getCurrentStatus: vi.fn(async () => "granted"),
    });
    const ok = await resolveLocationAccess(deps);

    expect(ok).toBe(true);
    expect(deps.requestPermission).not.toHaveBeenCalled();
  });

  it("stays silent when consent exists but the OS permission is not granted", async () => {
    const deps = makeDeps({
      silent: true,
      hasAccepted: vi.fn(async () => true),
      getCurrentStatus: vi.fn(async () => "undetermined"),
    });
    const ok = await resolveLocationAccess(deps);

    expect(ok).toBe(false);
    expect(deps.requestPermission).not.toHaveBeenCalled();
  });
});

describe("resolveLocationAccess — iOS keeps prompting directly", () => {
  it("goes straight to the OS prompt with no custom screen (App Store 5.1.1(iv))", async () => {
    const deps = makeDeps({ platform: "ios", hasAccepted: vi.fn(async () => false) });
    const ok = await resolveLocationAccess(deps);

    expect(ok).toBe(true);
    expect(deps.askForConsent).not.toHaveBeenCalled();
    expect(deps.hasAccepted).not.toHaveBeenCalled();
    expect(deps.requestPermission).toHaveBeenCalledTimes(1);
  });

  it("still honours silent mode on iOS", async () => {
    const deps = makeDeps({ platform: "ios", silent: true, getCurrentStatus: vi.fn(async () => "denied") });
    expect(await resolveLocationAccess(deps)).toBe(false);
    expect(deps.requestPermission).not.toHaveBeenCalled();
  });
});
