/**
 * Registry CRUD + on-demand poll.
 *
 * The per-customer management secret is write-only from the browser's view:
 * it can be SET or CLEARED but is never returned. List/get responses expose only
 * a `hasMgmtSecret` boolean.
 */

import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { pool, type CustomerRow } from "../db";
import { encryptSecret } from "../crypto";
import { isValidOrgCode, normalizeOrgCode, toSafeOrigin } from "../orgCode";
import { IS_PROD } from "../config";
import { pollAllOnce } from "../poller";

export const customersRouter = Router();

const baseFields = {
  name: z.string().trim().min(1).max(200),
  apiBaseUrl: z.string().trim().min(1).max(500),
  contactName: z.string().trim().max(200).optional().nullable(),
  contactEmail: z.string().trim().email().max(200).optional().or(z.literal("")).nullable(),
  notes: z.string().trim().max(2000).optional().nullable(),
  targetVersion: z.string().trim().max(200).optional().nullable(),
  mgmtSecret: z.string().max(500).optional().nullable(),
  isActive: z.boolean().optional(),
};

const createSchema = z.object({
  orgCode: z.string().trim().min(1).max(64),
  ...baseFields,
});

const updateSchema = z.object({
  orgCode: z.string().trim().min(1).max(64).optional(),
  name: baseFields.name.optional(),
  apiBaseUrl: baseFields.apiBaseUrl.optional(),
  contactName: baseFields.contactName,
  contactEmail: baseFields.contactEmail,
  notes: baseFields.notes,
  targetVersion: baseFields.targetVersion,
  mgmtSecret: baseFields.mgmtSecret,
  isActive: baseFields.isActive,
});

async function fleetTargetVersion(): Promise<string | null> {
  const { rows } = await pool.query<{ target_version: string | null }>(
    `SELECT target_version FROM control_plane_settings WHERE id = 'singleton'`,
  );
  return rows[0]?.target_version ?? null;
}

/** Parse the stored agreements snapshot; malformed/missing JSON → null. */
export function parseAgreements(
  raw: string | null,
): { fetchedAt: string | null; slots: Record<string, unknown> } | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { fetchedAt?: unknown; slots?: unknown };
    if (!parsed || typeof parsed !== "object") return null;
    const slots = parsed.slots;
    if (!slots || typeof slots !== "object" || Array.isArray(slots)) return null;
    return {
      fetchedAt: typeof parsed.fetchedAt === "string" ? parsed.fetchedAt : null,
      slots: slots as Record<string, unknown>,
    };
  } catch {
    return null;
  }
}

/**
 * Parse the stored commercial-config snapshot into the at-a-glance plan fields
 * the fleet overview needs. Malformed/missing JSON → null (renders as "unknown");
 * a snapshot present but with no config saved → { tier: null, monthlyPriceCents:
 * null } so the UI can distinguish "not set" from "never fetched".
 */
export function parseCustomerPlan(
  raw: string | null,
): { fetchedAt: string | null; tier: string | null; monthlyPriceCents: number | null } | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { fetchedAt?: unknown; config?: unknown };
    if (!parsed || typeof parsed !== "object") return null;
    const config =
      parsed.config && typeof parsed.config === "object" && !Array.isArray(parsed.config)
        ? (parsed.config as Record<string, unknown>)
        : null;
    const tier = config && typeof config.planTier === "string" ? config.planTier : null;
    const monthlyPriceCents =
      config && typeof config.monthlyPriceCents === "number" ? config.monthlyPriceCents : null;
    return {
      fetchedAt: typeof parsed.fetchedAt === "string" ? parsed.fetchedAt : null,
      tier,
      monthlyPriceCents,
    };
  } catch {
    return null;
  }
}

function serialize(row: CustomerRow, fleetTarget: string | null) {
  const effectiveTarget = row.target_version ?? fleetTarget;
  const needsUpdate = Boolean(
    effectiveTarget && row.reported_version && row.reported_version !== effectiveTarget,
  );
  return {
    id: row.id,
    orgCode: row.org_code,
    name: row.name,
    apiBaseUrl: row.api_base_url,
    contactName: row.contact_name,
    contactEmail: row.contact_email,
    notes: row.notes,
    targetVersion: row.target_version,
    effectiveTargetVersion: effectiveTarget,
    reportedVersion: row.reported_version,
    reportedBuiltAt: row.reported_built_at,
    lastStatus: row.last_status,
    lastLatencyMs: row.last_latency_ms,
    lastSeenAt: row.last_seen_at,
    lastError: row.last_error,
    isActive: row.is_active,
    hasMgmtSecret: Boolean(row.mgmt_secret_enc),
    agreements: parseAgreements(row.agreements_json),
    plan: parseCustomerPlan(row.customer_config_json),
    needsUpdate,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

customersRouter.get("/customers", async (_req, res) => {
  const fleetTarget = await fleetTargetVersion();
  const { rows } = await pool.query<CustomerRow>(
    `SELECT * FROM control_plane_customers ORDER BY name ASC`,
  );
  res.json({ customers: rows.map((r) => serialize(r, fleetTarget)) });
});

customersRouter.post("/customers", async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid customer", details: parsed.error.flatten() });
    return;
  }
  const d = parsed.data;
  const orgCode = normalizeOrgCode(d.orgCode);
  if (!isValidOrgCode(orgCode)) {
    res.status(400).json({ error: "Invalid org code (use lowercase letters, digits, hyphens)" });
    return;
  }
  const origin = toSafeOrigin(d.apiBaseUrl, IS_PROD);
  if (!origin) {
    res.status(400).json({ error: IS_PROD ? "Backend URL must be a valid https origin" : "Backend URL must be a valid URL" });
    return;
  }

  const id = randomUUID();
  const mgmtSecretEnc =
    d.mgmtSecret && d.mgmtSecret.trim().length > 0 ? encryptSecret(d.mgmtSecret.trim()) : null;

  try {
    const { rows } = await pool.query<CustomerRow>(
      `INSERT INTO control_plane_customers
         (id, org_code, name, api_base_url, contact_name, contact_email, notes, target_version, mgmt_secret_enc, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, COALESCE($10, TRUE))
       RETURNING *`,
      [
        id,
        orgCode,
        d.name,
        origin,
        d.contactName ?? null,
        d.contactEmail || null,
        d.notes ?? null,
        d.targetVersion || null,
        mgmtSecretEnc,
        d.isActive ?? null,
      ],
    );
    res.status(201).json({ customer: serialize(rows[0], await fleetTargetVersion()) });
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "23505") {
      res.status(409).json({ error: "An org code must be unique" });
      return;
    }
    throw err;
  }
});

customersRouter.put("/customers/:id", async (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid update", details: parsed.error.flatten() });
    return;
  }
  const d = parsed.data;
  const sets: string[] = [];
  const vals: unknown[] = [];
  let i = 1;
  const push = (col: string, val: unknown) => {
    sets.push(`${col} = $${++i}`);
    vals.push(val);
  };

  if (d.orgCode !== undefined) {
    const orgCode = normalizeOrgCode(d.orgCode);
    if (!isValidOrgCode(orgCode)) {
      res.status(400).json({ error: "Invalid org code" });
      return;
    }
    push("org_code", orgCode);
  }
  if (d.name !== undefined) push("name", d.name);
  if (d.apiBaseUrl !== undefined) {
    const origin = toSafeOrigin(d.apiBaseUrl, IS_PROD);
    if (!origin) {
      res.status(400).json({ error: IS_PROD ? "Backend URL must be a valid https origin" : "Backend URL must be a valid URL" });
      return;
    }
    push("api_base_url", origin);
  }
  if (d.contactName !== undefined) push("contact_name", d.contactName ?? null);
  if (d.contactEmail !== undefined) push("contact_email", d.contactEmail || null);
  if (d.notes !== undefined) push("notes", d.notes ?? null);
  if (d.targetVersion !== undefined) push("target_version", d.targetVersion || null);
  if (d.isActive !== undefined) push("is_active", d.isActive);
  if (d.mgmtSecret !== undefined) {
    const trimmed = (d.mgmtSecret ?? "").trim();
    push("mgmt_secret_enc", trimmed.length > 0 ? encryptSecret(trimmed) : null);
  }

  if (sets.length === 0) {
    res.status(400).json({ error: "No fields to update" });
    return;
  }
  sets.push("updated_at = now()");

  try {
    const { rows } = await pool.query<CustomerRow>(
      `UPDATE control_plane_customers SET ${sets.join(", ")} WHERE id = $1 RETURNING *`,
      [req.params.id, ...vals],
    );
    if (rows.length === 0) {
      res.status(404).json({ error: "Customer not found" });
      return;
    }
    res.json({ customer: serialize(rows[0], await fleetTargetVersion()) });
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "23505") {
      res.status(409).json({ error: "An org code must be unique" });
      return;
    }
    throw err;
  }
});

customersRouter.delete("/customers/:id", async (req, res) => {
  const { rowCount } = await pool.query(`DELETE FROM control_plane_customers WHERE id = $1`, [
    req.params.id,
  ]);
  if (!rowCount) {
    res.status(404).json({ error: "Customer not found" });
    return;
  }
  res.json({ ok: true });
});

customersRouter.post("/customers/poll", async (_req, res) => {
  await pollAllOnce();
  res.json({ ok: true });
});

// Fleet-wide settings (default target version).
customersRouter.get("/settings", async (_req, res) => {
  res.json({ targetVersion: await fleetTargetVersion() });
});

const fleetSettingsSchema = z.object({
  targetVersion: z.string().trim().max(200).optional().nullable(),
});

customersRouter.put("/settings", async (req, res) => {
  const parsed = fleetSettingsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid settings" });
    return;
  }
  await pool.query(
    `UPDATE control_plane_settings SET target_version = $1, updated_at = now() WHERE id = 'singleton'`,
    [parsed.data.targetVersion || null],
  );
  res.json({ targetVersion: parsed.data.targetVersion || null });
});
