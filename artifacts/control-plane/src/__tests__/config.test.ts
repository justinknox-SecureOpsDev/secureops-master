/**
 * Operator-credential config contract.
 *
 * The control plane accepts EITHER a bcrypt hash (preferred) OR a plaintext
 * password for the single operator identity. A secure production deployment
 * supplies only the hash — boot must NOT hard-fail demanding the plaintext env
 * in that case. Conversely, with neither supplied, prod must fail fast.
 *
 * config.ts reads env at module-evaluation time, so each case re-imports it
 * fresh under a mutated environment.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";

const CONFIG_ENV_KEYS = [
  "NODE_ENV",
  "CONTROL_PLANE_SESSION_SECRET",
  "CONTROL_PLANE_ENCRYPTION_KEY",
  "CONTROL_PLANE_OPERATOR_EMAIL",
  "CONTROL_PLANE_OPERATOR_PASSWORD",
  "CONTROL_PLANE_OPERATOR_PASSWORD_HASH",
] as const;

const saved: Record<string, string | undefined> = {};
for (const k of CONFIG_ENV_KEYS) saved[k] = process.env[k];

afterEach(() => {
  for (const k of CONFIG_ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.resetModules();
});

function setProdEnv(extra: Record<string, string | undefined>) {
  vi.resetModules();
  const base: Record<string, string | undefined> = {
    NODE_ENV: "production",
    CONTROL_PLANE_SESSION_SECRET: "x".repeat(24),
    CONTROL_PLANE_ENCRYPTION_KEY: "y".repeat(24),
    CONTROL_PLANE_OPERATOR_EMAIL: "op@cp.test",
    CONTROL_PLANE_OPERATOR_PASSWORD: undefined,
    CONTROL_PLANE_OPERATOR_PASSWORD_HASH: undefined,
    ...extra,
  };
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

describe("operator password config", () => {
  it("accepts hash-only production config (no plaintext password)", async () => {
    const hash = bcrypt.hashSync("s3cret-operator-pw", 8);
    setProdEnv({ CONTROL_PLANE_OPERATOR_PASSWORD_HASH: hash });
    const cfg = await import("../config");
    expect(cfg.IS_PROD).toBe(true);
    expect(cfg.OPERATOR_PASSWORD_HASH).toBe(hash);
    expect(cfg.OPERATOR_PASSWORD).toBe(""); // unused when a hash is present
  });

  it("verifies credentials against a hash-only config", async () => {
    const hash = bcrypt.hashSync("s3cret-operator-pw", 8);
    setProdEnv({ CONTROL_PLANE_OPERATOR_PASSWORD_HASH: hash });
    const { verifyOperatorCredentials } = await import("../auth");
    expect(verifyOperatorCredentials("op@cp.test", "s3cret-operator-pw")).toBe(true);
    expect(verifyOperatorCredentials("op@cp.test", "wrong")).toBe(false);
  });

  it("still requires plaintext password in prod when no hash is set", async () => {
    setProdEnv({});
    await expect(import("../config")).rejects.toThrow(/CONTROL_PLANE_OPERATOR_PASSWORD/);
  });
});
