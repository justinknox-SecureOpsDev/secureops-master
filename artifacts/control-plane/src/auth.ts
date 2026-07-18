/**
 * Operator authentication.
 *
 * The control plane has a SINGLE operator identity (this is an internal tool,
 * not a multi-tenant SaaS). Credentials come from env:
 *   - CONTROL_PLANE_OPERATOR_EMAIL
 *   - CONTROL_PLANE_OPERATOR_PASSWORD_HASH (bcrypt, preferred) OR
 *   - CONTROL_PLANE_OPERATOR_PASSWORD (plaintext)
 *
 * Login issues a short-lived JWT signed with CONTROL_PLANE_SESSION_SECRET.
 * Every operator API route (everything except login + the public directory
 * resolve + healthz) is gated by `requireOperator`.
 */

import { timingSafeEqual } from "node:crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import type { NextFunction, Request, Response } from "express";
import {
  JWT_TTL_SECONDS,
  OPERATOR_EMAIL,
  OPERATOR_PASSWORD,
  OPERATOR_PASSWORD_HASH,
  SESSION_SECRET,
} from "./config";

function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function verifyOperatorCredentials(email: string, password: string): boolean {
  const emailOk = constantTimeEquals((email ?? "").trim().toLowerCase(), OPERATOR_EMAIL);
  let passwordOk = false;
  if (OPERATOR_PASSWORD_HASH.length > 0) {
    try {
      passwordOk = bcrypt.compareSync(password ?? "", OPERATOR_PASSWORD_HASH);
    } catch {
      passwordOk = false;
    }
  } else {
    passwordOk = constantTimeEquals(password ?? "", OPERATOR_PASSWORD);
  }
  // Always evaluate both to keep timing roughly uniform.
  return emailOk && passwordOk;
}

export function issueOperatorToken(): string {
  return jwt.sign({ sub: OPERATOR_EMAIL, role: "operator" }, SESSION_SECRET, {
    expiresIn: JWT_TTL_SECONDS,
  });
}

export const requireOperator = (req: Request, res: Response, next: NextFunction): void => {
  const header = req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
  if (!token) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  try {
    const decoded = jwt.verify(token, SESSION_SECRET) as { role?: string; sub?: string };
    if (decoded.role !== "operator") {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    res.locals.operator = decoded.sub ?? OPERATOR_EMAIL;
    next();
  } catch {
    res.status(401).json({ error: "Unauthorized" });
  }
};
