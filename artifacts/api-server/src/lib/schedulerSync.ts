/**
 * Event Staff Scheduler Integration — HMAC auth + outbound sync client.
 *
 * Architecture:
 *   - Every cross-app HTTP request is signed with HMAC-SHA256 using the shared
 *     secret stored in SCHEDULER_SHARED_SECRET.
 *   - The scheduler's base URL is read from SCHEDULER_BASE_URL.
 *   - Outbound calls are best-effort: a scheduler outage never blocks SecureOps
 *     writes. Failures are logged with structured context.
 *   - Loop prevention: callers pass syncSource='scheduler' on records that
 *     arrived via webhook — the outbound hook checks this before pushing.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { logger } from "./logger";

export const SCHEDULER_SOURCE = "scheduler" as const;

/**
 * Connection config — read once from env at module load.
 * Both values must be non-empty for the integration to be active.
 */
export function getSchedulerConfig(): { baseUrl: string; secret: string } | null {
  const baseUrl = (process.env.SCHEDULER_BASE_URL ?? "").trim().replace(/\/$/, "");
  const secret = (process.env.SCHEDULER_SHARED_SECRET ?? "").trim();
  if (!baseUrl || !secret) return null;
  return { baseUrl, secret };
}

export function isSchedulerConfigured(): boolean {
  return getSchedulerConfig() !== null;
}

// ---------------------------------------------------------------------------
// HMAC helpers
// ---------------------------------------------------------------------------

/**
 * Returns the hex HMAC-SHA256 signature of `payload` (a raw string) using
 * `secret`. The scheduler must compute the same value over the same bytes.
 */
export function signPayload(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload, "utf8").digest("hex");
}

/**
 * Timing-safe comparison of a received signature against the expected one.
 * Returns false when the signature is missing or not a 64-char hex string.
 */
export function verifySignature(payload: string, receivedSig: string | undefined, secret: string): boolean {
  if (!receivedSig || typeof receivedSig !== "string" || receivedSig.length !== 64) return false;
  const expected = signPayload(payload, secret);
  try {
    return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(receivedSig, "hex"));
  } catch {
    return false;
  }
}

/**
 * Build a signed outbound request and POST it to the scheduler.
 * Returns null (no-op) when the integration is not configured.
 * Never throws — failures are logged and swallowed.
 */
async function postToScheduler(path: string, body: unknown): Promise<boolean> {
  const cfg = getSchedulerConfig();
  if (!cfg) return false;

  const payload = JSON.stringify(body);
  const sig = signPayload(payload, cfg.secret);
  const url = `${cfg.baseUrl}${path}`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-WCSG-Signature": sig,
        "X-WCSG-Source": "secureops",
      },
      body: payload,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      logger.warn({ url, status: res.status }, "[schedulerSync] outbound push returned non-2xx");
      return false;
    }
    return true;
  } catch (err) {
    logger.warn({ err, url }, "[schedulerSync] outbound push failed");
    return false;
  }
}

/**
 * Result of an admin-proxied request to the scheduler. `body` is the parsed
 * JSON (or raw text) of the scheduler's response so the proxy route can relay
 * both the status code and payload back to the portal verbatim.
 */
export type SchedulerProxyResult = {
  ok: boolean;
  status: number;
  body: unknown;
};

/**
 * Forward an admin-initiated event-management request to the scheduler with a
 * valid HMAC signature, and return the scheduler's status + parsed body.
 *
 * The signature is computed over the EXACT raw body bytes that are sent on the
 * wire (the empty string for body-less GET/DELETE requests) so the scheduler's
 * constant-time signature check matches what it receives.
 *
 * Returns null when the integration is not configured (no base URL / secret).
 * Throws on network/timeout failure — callers map that to a 502.
 */
export async function forwardToScheduler(
  method: string,
  path: string,
  opts: { body?: unknown; query?: Record<string, unknown> } = {},
): Promise<SchedulerProxyResult | null> {
  const cfg = getSchedulerConfig();
  if (!cfg) return null;

  const hasBody = opts.body !== undefined && opts.body !== null;
  const payload = hasBody ? JSON.stringify(opts.body) : "";
  const sig = signPayload(payload, cfg.secret);

  let url = `${cfg.baseUrl}${path}`;
  if (opts.query) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined && v !== null) qs.set(k, String(v));
    }
    const s = qs.toString();
    if (s) url += `?${s}`;
  }

  const headers: Record<string, string> = {
    "X-WCSG-Signature": sig,
    "X-WCSG-Source": "secureops",
  };
  if (hasBody) headers["Content-Type"] = "application/json";

  const res = await fetch(url, {
    method,
    headers,
    body: hasBody ? payload : undefined,
    signal: AbortSignal.timeout(10_000),
  });

  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { ok: res.ok, status: res.status, body };
}

// ---------------------------------------------------------------------------
// Outbound payload shapes (what SecureOps sends to the scheduler)
// ---------------------------------------------------------------------------

export type OutboundShift = {
  secureopsId: string;
  externalId?: string | null;
  title: string;
  siteId?: string | null;
  siteName?: string | null;
  startTime: string;
  endTime: string;
  payRate: string;
  billRate: string;
  requiredLicenseLevel: number;
  headcount: number;
  status: string;
  notes?: string | null;
  updatedAt: string;
};

export type OutboundClockEvent = {
  secureopsId: string;
  externalId?: string | null;
  employeeEmail: string;
  employeeName: string;
  shiftSecureopsId?: string | null;
  shiftExternalId?: string | null;
  siteId?: string | null;
  siteName?: string | null;
  clockInTime: string;
  clockOutTime?: string | null;
  hoursWorked?: string | null;
  approvalStatus: string;
  updatedAt: string;
};

export type OutboundShiftDelete = {
  secureopsId: string;
  externalId?: string | null;
  deletedAt: string;
};

export type OutboundAssignmentEvent = {
  action: "created" | "deleted";
  assignmentSecureopsId: string;
  shiftSecureopsId: string;
  shiftExternalId?: string | null;
  employeeEmail: string;
  employeeName: string;
  status: string;
  occurredAt: string;
};

/**
 * Push a created or updated shift to the scheduler.
 * Skips when `syncSource === 'scheduler'` to prevent echo loops.
 */
export async function pushShiftUpsert(shift: {
  id: string;
  externalId?: string | null;
  externalSource?: string | null;
  syncSource?: string | null;
  title: string;
  siteId?: string | null;
  startTime: Date | string;
  endTime: Date | string;
  payRate: string;
  billRate: string;
  requiredLicenseLevel: number;
  headcount: number;
  status: string;
  notes?: string | null;
  updatedAt: Date | string;
  siteName?: string | null;
}): Promise<void> {
  if (shift.syncSource === SCHEDULER_SOURCE) return;
  if (!isSchedulerConfigured()) return;

  const body: OutboundShift = {
    secureopsId: shift.id,
    externalId: shift.externalId ?? null,
    title: shift.title,
    siteId: shift.siteId ?? null,
    siteName: shift.siteName ?? null,
    startTime: new Date(shift.startTime).toISOString(),
    endTime: new Date(shift.endTime).toISOString(),
    payRate: shift.payRate,
    billRate: shift.billRate,
    requiredLicenseLevel: shift.requiredLicenseLevel,
    headcount: shift.headcount,
    status: shift.status,
    notes: shift.notes ?? null,
    updatedAt: new Date(shift.updatedAt).toISOString(),
  };

  await postToScheduler("/api/secureops-webhook/shifts", body);
}

/**
 * Push a shift deletion to the scheduler.
 * Always pushes — this function is only called from locally-initiated delete
 * paths (DELETE /shifts/:id and DELETE /shifts/bulk). Inbound webhook/reconcile
 * deletes call db.delete() directly, so there is no echo-loop risk here.
 */
export async function pushShiftDelete(shift: {
  id: string;
  externalId?: string | null;
  syncSource?: string | null;
}): Promise<void> {
  if (!isSchedulerConfigured()) return;

  const body: OutboundShiftDelete = {
    secureopsId: shift.id,
    externalId: shift.externalId ?? null,
    deletedAt: new Date().toISOString(),
  };

  await postToScheduler("/api/secureops-webhook/shifts/delete", body);
}

/**
 * Push a clock in/out event (time entry) to the scheduler.
 * Skips when `syncSource === 'scheduler'` to prevent echo loops.
 */
export async function pushClockEvent(entry: {
  id: string;
  externalId?: string | null;
  syncSource?: string | null;
  employeeEmail: string;
  employeeName: string;
  shiftId?: string | null;
  shiftExternalId?: string | null;
  siteId?: string | null;
  siteName?: string | null;
  clockInTime: Date | string;
  clockOutTime?: Date | string | null;
  hoursWorked?: string | null;
  approvalStatus: string;
  updatedAt: Date | string;
}): Promise<void> {
  if (entry.syncSource === SCHEDULER_SOURCE) return;
  if (!isSchedulerConfigured()) return;

  const body: OutboundClockEvent = {
    secureopsId: entry.id,
    externalId: entry.externalId ?? null,
    employeeEmail: entry.employeeEmail,
    employeeName: entry.employeeName,
    shiftSecureopsId: entry.shiftId ?? null,
    shiftExternalId: entry.shiftExternalId ?? null,
    siteId: entry.siteId ?? null,
    siteName: entry.siteName ?? null,
    clockInTime: new Date(entry.clockInTime).toISOString(),
    clockOutTime: entry.clockOutTime ? new Date(entry.clockOutTime).toISOString() : null,
    hoursWorked: entry.hoursWorked ?? null,
    approvalStatus: entry.approvalStatus,
    updatedAt: new Date(entry.updatedAt).toISOString(),
  };

  await postToScheduler("/api/secureops-webhook/clock-events", body);
}

/**
 * Push a shift-assignment change (officer added or removed) to the scheduler so
 * its roster view stays in sync. `action: "created"` for a new assignment
 * (officer self-claim or admin/dispatcher forced assign); `action: "deleted"`
 * when an assignment is declined/removed and the slot frees up.
 *
 * Loop prevention: skips when the parent shift's `syncSource === 'scheduler'`,
 * since those assignment changes originated on the scheduler side.
 */
export async function pushAssignmentEvent(evt: {
  action: "created" | "deleted";
  assignmentId: string;
  shiftId: string;
  shiftExternalId?: string | null;
  shiftSyncSource?: string | null;
  employeeEmail: string;
  employeeName: string;
  status: string;
}): Promise<void> {
  if (evt.shiftSyncSource === SCHEDULER_SOURCE) return;
  if (!isSchedulerConfigured()) return;

  const body: OutboundAssignmentEvent = {
    action: evt.action,
    assignmentSecureopsId: evt.assignmentId,
    shiftSecureopsId: evt.shiftId,
    shiftExternalId: evt.shiftExternalId ?? null,
    employeeEmail: evt.employeeEmail,
    employeeName: evt.employeeName,
    status: evt.status,
    occurredAt: new Date().toISOString(),
  };

  await postToScheduler("/api/secureops-webhook/assignments", body);
}

/**
 * Fetch a delta of scheduler changes since `since` (ISO timestamp).
 * Returns null when the integration is not configured or the request fails.
 */
export type SchedulerShiftPayload = {
  id: string;
  title?: string | null;
  siteName?: string | null;
  startTime?: string | null;
  endTime?: string | null;
  payRate?: string | null;
  billRate?: string | null;
  requiredLicenseLevel?: number | null;
  headcount?: number | null;
  status?: string | null;
  notes?: string | null;
  /**
   * Full set of officer emails the scheduler considers assigned to this shift.
   * The scheduler is authoritative for the roster: when present, SecureOps adds
   * assignments for newly-listed officers and removes assignments for officers
   * no longer listed. `undefined` means "no roster info in this payload" (leave
   * assignments untouched); an empty array means "clear the roster". Carried by
   * both the webhook payload AND the delta pull so the reconcile job stays in
   * sync with the webhook handler.
   */
  assignedOfficerEmails?: string[];
  updatedAt: string;
  deleted?: boolean;
};

export type SchedulerClockEventPayload = {
  id: string;
  employeeEmail: string;
  shiftId?: string | null;
  siteName?: string | null;
  clockInTime: string;
  clockOutTime?: string | null;
  hoursWorked?: string | null;
  updatedAt: string;
};

export type SchedulerDelta = {
  shifts: SchedulerShiftPayload[];
  clockEvents: SchedulerClockEventPayload[];
  nextCursor: string;
};

export async function fetchSchedulerDelta(since: string): Promise<SchedulerDelta | null> {
  const cfg = getSchedulerConfig();
  if (!cfg) return null;

  const payload = JSON.stringify({ since });
  const sig = signPayload(payload, cfg.secret);
  const url = `${cfg.baseUrl}/api/secureops-delta`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-WCSG-Signature": sig,
        "X-WCSG-Source": "secureops",
      },
      body: payload,
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      logger.warn({ url, status: res.status }, "[schedulerSync] delta fetch returned non-2xx");
      return null;
    }
    return (await res.json()) as SchedulerDelta;
  } catch (err) {
    logger.warn({ err, url }, "[schedulerSync] delta fetch failed");
    return null;
  }
}

/**
 * Test connectivity: POST to the scheduler's /api/secureops-ping endpoint.
 * Returns { ok: true } on success, { ok: false, error } on failure.
 */
export async function testSchedulerConnection(): Promise<{ ok: boolean; error?: string; statusCode?: number }> {
  const cfg = getSchedulerConfig();
  if (!cfg) return { ok: false, error: "Scheduler integration not configured (missing SCHEDULER_BASE_URL or SCHEDULER_SHARED_SECRET)" };

  const payload = JSON.stringify({ ping: true, ts: new Date().toISOString() });
  const sig = signPayload(payload, cfg.secret);
  const url = `${cfg.baseUrl}/api/secureops-ping`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-WCSG-Signature": sig,
        "X-WCSG-Source": "secureops",
      },
      body: payload,
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) {
      return { ok: false, statusCode: res.status, error: `Scheduler returned HTTP ${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}
