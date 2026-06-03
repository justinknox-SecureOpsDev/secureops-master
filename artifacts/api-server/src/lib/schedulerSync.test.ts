import { describe, it, expect, vi, beforeEach } from "vitest";
import { signPayload, verifySignature, isSchedulerConfigured, getSchedulerConfig } from "./schedulerSync";

// ---------------------------------------------------------------------------
// HMAC helpers
// ---------------------------------------------------------------------------

describe("signPayload / verifySignature", () => {
  const secret = "test-secret-abc123";
  const payload = JSON.stringify({ id: "shift-1", title: "Morning Patrol" });

  it("produces a 64-char hex string", () => {
    const sig = signPayload(payload, secret);
    expect(sig).toHaveLength(64);
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
  });

  it("verifies a correct signature", () => {
    const sig = signPayload(payload, secret);
    expect(verifySignature(payload, sig, secret)).toBe(true);
  });

  it("rejects a tampered payload", () => {
    const sig = signPayload(payload, secret);
    const tampered = JSON.stringify({ id: "shift-1", title: "Evening Patrol" });
    expect(verifySignature(tampered, sig, secret)).toBe(false);
  });

  it("rejects a wrong secret", () => {
    const sig = signPayload(payload, secret);
    expect(verifySignature(payload, sig, "different-secret")).toBe(false);
  });

  it("rejects undefined signature", () => {
    expect(verifySignature(payload, undefined, secret)).toBe(false);
  });

  it("rejects a short/truncated signature", () => {
    const sig = signPayload(payload, secret).slice(0, 32);
    expect(verifySignature(payload, sig, secret)).toBe(false);
  });

  it("rejects an empty string signature", () => {
    expect(verifySignature(payload, "", secret)).toBe(false);
  });

  it("is deterministic — same inputs produce same sig", () => {
    expect(signPayload(payload, secret)).toBe(signPayload(payload, secret));
  });
});

// ---------------------------------------------------------------------------
// isSchedulerConfigured / getSchedulerConfig
// ---------------------------------------------------------------------------

describe("isSchedulerConfigured", () => {
  beforeEach(() => {
    delete process.env.SCHEDULER_BASE_URL;
    delete process.env.SCHEDULER_SHARED_SECRET;
  });

  it("returns false when both env vars are missing", () => {
    expect(isSchedulerConfigured()).toBe(false);
  });

  it("returns false when only SCHEDULER_BASE_URL is set", () => {
    process.env.SCHEDULER_BASE_URL = "https://scheduler.example.com";
    expect(isSchedulerConfigured()).toBe(false);
  });

  it("returns false when only SCHEDULER_SHARED_SECRET is set", () => {
    process.env.SCHEDULER_SHARED_SECRET = "some-secret";
    expect(isSchedulerConfigured()).toBe(false);
  });

  it("returns true when both are set", () => {
    process.env.SCHEDULER_BASE_URL = "https://scheduler.example.com";
    process.env.SCHEDULER_SHARED_SECRET = "some-secret";
    expect(isSchedulerConfigured()).toBe(true);
  });

  it("getSchedulerConfig strips trailing slash from baseUrl", () => {
    process.env.SCHEDULER_BASE_URL = "https://scheduler.example.com/";
    process.env.SCHEDULER_SHARED_SECRET = "some-secret";
    const cfg = getSchedulerConfig();
    expect(cfg?.baseUrl).toBe("https://scheduler.example.com");
  });
});

// ---------------------------------------------------------------------------
// Loop prevention: pushShiftUpsert / pushClockEvent skip when syncSource='scheduler'
// ---------------------------------------------------------------------------

describe("loop prevention", () => {
  beforeEach(() => {
    process.env.SCHEDULER_BASE_URL = "https://scheduler.example.com";
    process.env.SCHEDULER_SHARED_SECRET = "some-secret";
    vi.resetAllMocks();
  });

  it("pushShiftUpsert skips when syncSource is 'scheduler'", async () => {
    const { pushShiftUpsert } = await import("./schedulerSync");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));

    await pushShiftUpsert({
      id: "shift-1",
      syncSource: "scheduler",
      externalId: "ext-1",
      title: "Test",
      startTime: new Date(),
      endTime: new Date(),
      payRate: "20",
      billRate: "28",
      requiredLicenseLevel: 2,
      headcount: 2,
      status: "upcoming",
      updatedAt: new Date(),
    });

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("pushShiftUpsert fires when syncSource is 'local'", async () => {
    const { pushShiftUpsert } = await import("./schedulerSync");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));

    await pushShiftUpsert({
      id: "shift-2",
      syncSource: "local",
      title: "Test",
      startTime: new Date(),
      endTime: new Date(),
      payRate: "20",
      billRate: "28",
      requiredLicenseLevel: 2,
      headcount: 2,
      status: "upcoming",
      updatedAt: new Date(),
    });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/secureops-webhook/shifts");
    expect(opts.headers).toMatchObject({ "X-WCSG-Source": "secureops" });
    expect(typeof (opts.headers as Record<string, string>)["X-WCSG-Signature"]).toBe("string");
    expect((opts.headers as Record<string, string>)["X-WCSG-Signature"]).toHaveLength(64);
  });

  it("pushShiftDelete always fires regardless of syncSource (only called from local delete paths)", async () => {
    // pushShiftDelete has no syncSource guard because it is only ever called
    // from admin-initiated DELETE /shifts/:id and DELETE /shifts/bulk handlers.
    // Inbound webhook/reconcile deletes go directly to db.delete(), so there is
    // no echo-loop risk and no reason to suppress based on origin.
    const { pushShiftDelete } = await import("./schedulerSync");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));

    await pushShiftDelete({ id: "s1", syncSource: "scheduler", externalId: null });
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/secureops-webhook/shifts/delete");
  });

  it("pushClockEvent skips when syncSource is 'scheduler'", async () => {
    const { pushClockEvent } = await import("./schedulerSync");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));

    await pushClockEvent({
      id: "te-1",
      syncSource: "scheduler",
      employeeEmail: "j@example.com",
      employeeName: "Jane",
      clockInTime: new Date(),
      approvalStatus: "pending",
      updatedAt: new Date(),
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("pushAssignmentEvent skips when the parent shift's syncSource is 'scheduler'", async () => {
    const { pushAssignmentEvent } = await import("./schedulerSync");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));

    await pushAssignmentEvent({
      action: "created",
      assignmentId: "a-1",
      shiftId: "shift-1",
      shiftExternalId: "ext-1",
      shiftSyncSource: "scheduler",
      employeeEmail: "j@example.com",
      employeeName: "Jane",
      status: "accepted",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("pushAssignmentEvent fires a 'created' event when the parent shift is local", async () => {
    const { pushAssignmentEvent } = await import("./schedulerSync");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));

    await pushAssignmentEvent({
      action: "created",
      assignmentId: "a-2",
      shiftId: "shift-2",
      shiftExternalId: null,
      shiftSyncSource: "local",
      employeeEmail: "j@example.com",
      employeeName: "Jane Officer",
      status: "accepted",
    });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/secureops-webhook/assignments");
    expect(opts.headers).toMatchObject({ "X-WCSG-Source": "secureops" });
    const body = JSON.parse(opts.body as string);
    expect(body).toMatchObject({
      action: "created",
      assignmentSecureopsId: "a-2",
      shiftSecureopsId: "shift-2",
      employeeEmail: "j@example.com",
      status: "accepted",
    });
  });

  it("pushAssignmentEvent fires a 'deleted' event when an assignment is removed", async () => {
    const { pushAssignmentEvent } = await import("./schedulerSync");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));

    await pushAssignmentEvent({
      action: "deleted",
      assignmentId: "a-3",
      shiftId: "shift-3",
      shiftExternalId: "ext-3",
      shiftSyncSource: "local",
      employeeEmail: "j@example.com",
      employeeName: "Jane Officer",
      status: "declined",
    });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/secureops-webhook/assignments");
    const body = JSON.parse(opts.body as string);
    expect(body).toMatchObject({ action: "deleted", assignmentSecureopsId: "a-3", status: "declined" });
  });
});

// ---------------------------------------------------------------------------
// Outbound payload signature correctness
// ---------------------------------------------------------------------------

describe("outbound request signing", () => {
  beforeEach(() => {
    process.env.SCHEDULER_BASE_URL = "https://scheduler.example.com";
    process.env.SCHEDULER_SHARED_SECRET = "verifiable-secret";
    vi.resetAllMocks();
  });

  it("signature header is valid HMAC of the request body", async () => {
    const { pushShiftUpsert } = await import("./schedulerSync");
    let capturedBody = "";
    let capturedSig = "";

    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, opts) => {
      capturedBody = opts?.body as string;
      capturedSig = (opts?.headers as Record<string, string>)["X-WCSG-Signature"];
      return new Response("{}", { status: 200 });
    });

    await pushShiftUpsert({
      id: "shift-sig-test",
      syncSource: "local",
      title: "Sig Test Shift",
      startTime: new Date("2026-07-01T08:00:00Z"),
      endTime: new Date("2026-07-01T16:00:00Z"),
      payRate: "22",
      billRate: "30",
      requiredLicenseLevel: 2,
      headcount: 1,
      status: "upcoming",
      updatedAt: new Date("2026-07-01T00:00:00Z"),
    });

    // Verify the captured body + sig match
    const expected = signPayload(capturedBody, "verifiable-secret");
    expect(capturedSig).toBe(expected);
    expect(verifySignature(capturedBody, capturedSig, "verifiable-secret")).toBe(true);
  });
});
