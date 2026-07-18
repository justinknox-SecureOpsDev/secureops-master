/**
 * Control-plane management surface — inbound HMAC authentication.
 *
 * The master control plane (a separate operator-only deployment) manages this
 * customer backend's brand + feature flags remotely. Every such request is
 * signed with HMAC-SHA256 over the EXACT raw request body, using a shared
 * secret unique to this customer (`CONTROL_PLANE_SHARED_SECRET`). This mirrors
 * the scheduler integration's HMAC scheme (see lib/schedulerSync.ts).
 *
 * Posture:
 *   - INERT by default. With no `CONTROL_PLANE_SHARED_SECRET` set, the whole
 *     surface returns 503 — it cannot be probed or used until an operator
 *     explicitly provisions the secret on this deployment.
 *   - Signature is verified in constant time over the raw body bytes.
 *   - This is an authentication boundary ONLY (no user/session); it is reused
 *     across the small set of control-plane routes and never mixed with the
 *     normal JWT auth.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { logger } from "./logger";

export const CONTROL_PLANE_SIGNATURE_HEADER = "x-control-plane-signature";

export function getControlPlaneSecret(): string | null {
  const secret = (process.env.CONTROL_PLANE_SHARED_SECRET ?? "").trim();
  return secret.length > 0 ? secret : null;
}

export function isControlPlaneConfigured(): boolean {
  return getControlPlaneSecret() !== null;
}

/** Hex HMAC-SHA256 of `payload` under `secret`. */
export function signControlPlanePayload(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload, "utf8").digest("hex");
}

/**
 * Constant-time check of a received signature against the expected one.
 * False when the signature is missing or not a 64-char hex string.
 */
export function verifyControlPlaneSignature(
  payload: string,
  receivedSig: string | undefined,
  secret: string,
): boolean {
  if (!receivedSig || typeof receivedSig !== "string" || receivedSig.length !== 64) return false;
  const expected = signControlPlanePayload(payload, secret);
  try {
    return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(receivedSig, "hex"));
  } catch {
    return false;
  }
}

/**
 * Express middleware gating the control-plane surface.
 *
 * Requires `express.json({ verify })` upstream to have stashed the raw body on
 * `req.rawBody` so the signature is checked over the exact bytes received (app
 * wiring already does this for the scheduler webhook). Falls back to
 * re-serialising `req.body` only when no raw body was captured (e.g. an empty
 * GET), matching how the control-plane client signs body-less requests as "".
 */
export const requireControlPlaneHmac = (req: Request, res: Response, next: NextFunction): void => {
  const secret = getControlPlaneSecret();
  if (!secret) {
    res.status(503).json({
      error: "Control plane not configured",
      message: "CONTROL_PLANE_SHARED_SECRET is not set on this deployment.",
    });
    return;
  }

  const rawBody = (req as Request & { rawBody?: string }).rawBody;
  const payload =
    typeof rawBody === "string"
      ? rawBody
      : req.body && Object.keys(req.body).length > 0
        ? JSON.stringify(req.body)
        : "";

  const sig = req.header(CONTROL_PLANE_SIGNATURE_HEADER) ?? undefined;
  if (!verifyControlPlaneSignature(payload, sig, secret)) {
    logger.warn({ path: req.path }, "[controlPlane] rejected request with invalid signature");
    res.status(401).json({ error: "Unauthorized", message: "Invalid control-plane signature." });
    return;
  }

  next();
};
