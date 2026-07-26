/**
 * Outbound HMAC client → customer /api/control-plane/* surface.
 *
 * Mirrors the customer-side verifier (artifacts/api-server/src/lib/controlPlaneAuth.ts):
 * we sign the EXACT raw request body (body-less requests sign "") with
 * HMAC-SHA256 under that customer's shared secret and send it in the
 * `x-control-plane-signature` header.
 */

import { createHmac } from "node:crypto";
import { POLL_TIMEOUT_MS } from "./config";

export const CONTROL_PLANE_SIGNATURE_HEADER = "x-control-plane-signature";

export function signControlPlanePayload(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload, "utf8").digest("hex");
}

export interface RemoteResult {
  status: number;
  ok: boolean;
  body: unknown;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

/**
 * Call a customer control-plane endpoint with a signed request.
 * `method` GET has no body (signs ""); PUT/POST sign JSON.stringify(body).
 */
export async function callCustomerControlPlane(
  origin: string,
  path: string,
  method: "GET" | "PUT" | "POST" | "DELETE",
  secret: string,
  body?: unknown,
): Promise<RemoteResult> {
  const bodyless = method === "GET" || method === "DELETE" || body === undefined;
  const payload = bodyless ? "" : JSON.stringify(body);
  const sig = signControlPlanePayload(payload, secret);
  const headers: Record<string, string> = { [CONTROL_PLANE_SIGNATURE_HEADER]: sig };
  const init: RequestInit = { method, headers };
  if (!bodyless) {
    headers["Content-Type"] = "application/json";
    init.body = payload;
  }
  const res = await fetchWithTimeout(`${origin}${path}`, init, POLL_TIMEOUT_MS);
  let parsed: unknown = null;
  const text = await res.text();
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: res.status, ok: res.ok, body: parsed };
}
