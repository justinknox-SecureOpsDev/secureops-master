/**
 * Remote settings proxy.
 *
 * The operator reads + writes a customer's brand + feature flags WITHOUT logging
 * into that customer's admin portal. We fetch the customer row, decrypt its
 * management secret, and make a signed HMAC call to that backend's
 * /api/control-plane/* surface. The shared secret never leaves the server.
 *
 * Validation is intentionally thin here — the customer backend re-validates
 * every field with the SAME zod schema the in-app super-admin routes use, so the
 * control plane stays a faithful conduit and the authority lives in one place.
 */

import { randomUUID } from "node:crypto";
import { Router } from "express";
import { pool, type CustomerRow, type RemoteChangeRow } from "../db";
import { decryptSecret } from "../crypto";
import { callCustomerControlPlane } from "../hmacClient";
import { logger } from "../logger";

export const remoteSettingsRouter = Router();

/** Build a concise human-readable summary of a brand PUT body. */
export function summarizeBrand(body: unknown): string {
  if (!body || typeof body !== "object") return "Updated brand";
  const keys = Object.keys(body as Record<string, unknown>).filter(
    (k) => (body as Record<string, unknown>)[k] !== undefined,
  );
  if (keys.length === 0) return "Updated brand";
  return "Updated brand: " + keys.join(", ");
}

/** Build a concise human-readable summary of a features PUT body. */
export function summarizeFeatures(body: unknown): string {
  const updates =
    body && typeof body === "object" ? (body as { updates?: unknown }).updates : undefined;
  if (!Array.isArray(updates) || updates.length === 0) return "Updated feature flags";
  const parts = updates
    .filter((u): u is { key: string; enabled: boolean } => Boolean(u) && typeof u === "object")
    .map((u) => `${u.key}=${u.enabled ? "on" : "off"}`);
  return parts.length > 0 ? "Updated features: " + parts.join(", ") : "Updated feature flags";
}

/**
 * Build a concise human-readable summary of a plan/billing PUT body. The control
 * plane is a conduit and doesn't hold the customer's prior values, so this
 * describes the SUBMITTED commercial config (what the operator saved) rather
 * than a diff — mirroring how the brand/feature summaries work.
 */
export function summarizePlanBilling(body: unknown): string {
  if (!body || typeof body !== "object") return "Updated plan & billing";
  const b = body as Record<string, unknown>;
  const has = (k: string) => Object.prototype.hasOwnProperty.call(b, k) && b[k] !== undefined;
  const parts: string[] = [];
  if (has("planTier")) parts.push("plan " + (b.planTier ? String(b.planTier) : "unset"));
  if (has("monthlyPriceCents")) {
    parts.push(
      b.monthlyPriceCents == null
        ? "price unset"
        : "$" + (Number(b.monthlyPriceCents) / 100).toFixed(0) + "/mo",
    );
  }
  if (has("officerCount")) {
    parts.push(b.officerCount == null ? "officers unset" : String(b.officerCount) + " officers");
  }
  if (has("processingFeeEnabled")) {
    if (b.processingFeeEnabled) {
      const rate = has("processingFeeRate") && b.processingFeeRate ? " " + String(b.processingFeeRate) + "%" : "";
      parts.push("fee on" + rate);
    } else {
      parts.push("fee off");
    }
  }
  if (has("timeConfirmEditWindowHours")) {
    const w = b.timeConfirmEditWindowHours;
    parts.push(w ? "time-edit " + String(w) + "h" : "time-edit default");
  }
  if (has("planStartDate") && b.planStartDate) parts.push("start " + String(b.planStartDate));
  if (has("customerName") && b.customerName) parts.push("name " + String(b.customerName));
  if (has("billingNotes") && b.billingNotes) parts.push("notes updated");
  return parts.length ? "Updated plan & billing: " + parts.join(", ") : "Updated plan & billing";
}

async function recordChange(
  customerId: string,
  operator: string,
  kind: "brand" | "features" | "plan_billing",
  summary: string,
  status: number | null,
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO control_plane_remote_changes (id, customer_id, operator, kind, summary, status)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [randomUUID(), customerId, operator, kind, summary, status],
    );
  } catch (err) {
    logger.error({ err: String(err), id: customerId }, "[remoteSettings] failed to record audit row");
  }
}

function serializeChange(row: RemoteChangeRow) {
  return {
    id: row.id,
    operator: row.operator,
    kind: row.kind,
    summary: row.summary,
    status: row.status,
    createdAt: row.created_at,
  };
}

async function loadCustomer(id: string): Promise<CustomerRow | null> {
  const { rows } = await pool.query<CustomerRow>(
    `SELECT * FROM control_plane_customers WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

function resolveSecret(row: CustomerRow): string | null {
  if (!row.mgmt_secret_enc) return null;
  try {
    return decryptSecret(row.mgmt_secret_enc);
  } catch (err) {
    logger.error({ err: String(err), id: row.id }, "[remoteSettings] secret decrypt failed");
    return null;
  }
}

async function proxy(
  res: import("express").Response,
  row: CustomerRow,
  method: "GET" | "PUT",
  path: string,
  body?: unknown,
): Promise<number | null> {
  const secret = resolveSecret(row);
  if (!secret) {
    res.status(409).json({ error: "No management secret configured for this customer" });
    return null;
  }
  try {
    const result = await callCustomerControlPlane(row.api_base_url, path, method, secret, body);
    res.status(result.status).json({ remote: result.body, status: result.status });
    return result.status;
  } catch (err) {
    logger.error({ err: String(err), id: row.id }, "[remoteSettings] proxy call failed");
    res.status(502).json({ error: "Failed to reach customer backend", detail: String(err) });
    return null;
  }
}

remoteSettingsRouter.get("/customers/:id/remote-settings", async (req, res) => {
  const row = await loadCustomer(req.params.id);
  if (!row) {
    res.status(404).json({ error: "Customer not found" });
    return;
  }
  await proxy(res, row, "GET", "/api/control-plane/settings");
});

remoteSettingsRouter.put("/customers/:id/remote-settings/brand", async (req, res) => {
  const row = await loadCustomer(req.params.id);
  if (!row) {
    res.status(404).json({ error: "Customer not found" });
    return;
  }
  const status = await proxy(res, row, "PUT", "/api/control-plane/brand", req.body ?? {});
  if (status === 200) {
    const operator = (res.locals.operator as string) || "operator";
    await recordChange(row.id, operator, "brand", summarizeBrand(req.body), status);
  }
});

remoteSettingsRouter.put("/customers/:id/remote-settings/features", async (req, res) => {
  const row = await loadCustomer(req.params.id);
  if (!row) {
    res.status(404).json({ error: "Customer not found" });
    return;
  }
  const status = await proxy(res, row, "PUT", "/api/control-plane/features", req.body ?? {});
  if (status === 200) {
    const operator = (res.locals.operator as string) || "operator";
    await recordChange(row.id, operator, "features", summarizeFeatures(req.body), status);
  }
});

remoteSettingsRouter.put("/customers/:id/remote-settings/plan-billing", async (req, res) => {
  const row = await loadCustomer(req.params.id);
  if (!row) {
    res.status(404).json({ error: "Customer not found" });
    return;
  }
  const status = await proxy(res, row, "PUT", "/api/control-plane/customer-config", req.body ?? {});
  if (status === 200) {
    const operator = (res.locals.operator as string) || "operator";
    await recordChange(row.id, operator, "plan_billing", summarizePlanBilling(req.body), status);
  }
});

remoteSettingsRouter.get("/customers/:id/remote-settings/history", async (req, res) => {
  const row = await loadCustomer(req.params.id);
  if (!row) {
    res.status(404).json({ error: "Customer not found" });
    return;
  }
  const { rows } = await pool.query<RemoteChangeRow>(
    `SELECT * FROM control_plane_remote_changes
     WHERE customer_id = $1
     ORDER BY created_at DESC
     LIMIT 50`,
    [row.id],
  );
  res.json({ changes: rows.map(serializeChange) });
});

/**
 * Build the WHERE clauses + bound params for the fleet activity feed from the
 * operator's optional filters. Pure + RN-free so it's unit-testable without a DB.
 *
 * Supported filters (all optional):
 *   - customerId — exact customer match
 *   - kind       — "brand" | "features" | "plan_billing" (anything else ignored)
 *   - since      — only changes at/after this instant (>=)
 *   - until      — only changes at/before this instant; a date-only value
 *                  ("YYYY-MM-DD") is treated as inclusive of that whole day
 *
 * Unparseable dates and unknown kinds are silently dropped rather than 400-ing,
 * so a half-typed filter never breaks the feed.
 */
export function buildRemoteChangesFilter(query: Record<string, unknown>): {
  clauses: string[];
  params: unknown[];
} {
  const clauses: string[] = [];
  const params: unknown[] = [];

  const customerId = typeof query.customerId === "string" ? query.customerId.trim() : "";
  if (customerId) {
    params.push(customerId);
    clauses.push(`rc.customer_id = $${params.length}`);
  }

  const kind = typeof query.kind === "string" ? query.kind.trim() : "";
  if (kind === "brand" || kind === "features" || kind === "plan_billing") {
    params.push(kind);
    clauses.push(`rc.kind = $${params.length}`);
  }

  const since = typeof query.since === "string" ? query.since.trim() : "";
  if (since) {
    const d = new Date(since);
    if (!Number.isNaN(d.getTime())) {
      params.push(d.toISOString());
      clauses.push(`rc.created_at >= $${params.length}`);
    }
  }

  const until = typeof query.until === "string" ? query.until.trim() : "";
  if (until) {
    const d = new Date(until);
    if (!Number.isNaN(d.getTime())) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(until)) {
        // Date-only: make the upper bound inclusive of the entire day.
        const next = new Date(d.getTime() + 24 * 60 * 60 * 1000);
        params.push(next.toISOString());
        clauses.push(`rc.created_at < $${params.length}`);
      } else {
        params.push(d.toISOString());
        clauses.push(`rc.created_at <= $${params.length}`);
      }
    }
  }

  return { clauses, params };
}

/**
 * Fleet-wide feed of recent remote changes across EVERY customer, newest first,
 * with the customer name + id attached so the dashboard can link each row back
 * to its customer. Capped so an operator can answer "what changed recently,
 * anywhere?" at a glance; optional customerId/kind/since/until filters narrow it
 * server-side so the feed stays useful beyond the 50-row cap.
 */
remoteSettingsRouter.get("/remote-changes", async (req, res) => {
  const { clauses, params } = buildRemoteChangesFilter(req.query as Record<string, unknown>);
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const { rows } = await pool.query<RemoteChangeRow & { customer_name: string | null }>(
    `SELECT rc.*, c.name AS customer_name
       FROM control_plane_remote_changes rc
       LEFT JOIN control_plane_customers c ON c.id = rc.customer_id
      ${where}
      ORDER BY rc.created_at DESC
      LIMIT 50`,
    params,
  );
  res.json({
    changes: rows.map((row) => ({
      ...serializeChange(row),
      customerId: row.customer_id,
      customerName: row.customer_name,
    })),
  });
});

/**
 * Escape one value for a CSV cell. Wraps in quotes and doubles embedded quotes
 * per RFC 4180, AND neutralises spreadsheet formula injection by prefixing any
 * value that begins with a formula trigger (= + - @, or a leading tab / CR) with
 * a single quote so Excel/Sheets treat it as text, never an executable formula.
 */
export function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(s)) {
    s = "'" + s;
  }
  return '"' + s.replace(/"/g, '""') + '"';
}

/**
 * Stream the FULL fleet-wide change history as a CSV download (no 50-row cap),
 * newest-first, for compliance reviews and post-incident write-ups. Every cell
 * is CSV/formula-injection-safe.
 */
remoteSettingsRouter.get("/remote-changes.csv", async (_req, res) => {
  const { rows } = await pool.query<
    RemoteChangeRow & { customer_name: string | null; org_code: string | null }
  >(
    `SELECT rc.*, c.name AS customer_name, c.org_code AS org_code
       FROM control_plane_remote_changes rc
       LEFT JOIN control_plane_customers c ON c.id = rc.customer_id
      ORDER BY rc.created_at DESC`,
  );

  const header = [
    "Customer",
    "Org code",
    "Kind",
    "Summary",
    "Operator",
    "Status",
    "Timestamp",
  ];
  const lines = [header.map(csvCell).join(",")];
  for (const row of rows) {
    lines.push(
      [
        csvCell(row.customer_name ?? "(removed customer)"),
        csvCell(row.org_code ?? ""),
        csvCell(row.kind),
        csvCell(row.summary),
        csvCell(row.operator),
        csvCell(row.status),
        csvCell(row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at),
      ].join(","),
    );
  }

  const csv = lines.join("\r\n") + "\r\n";
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="fleet-change-history-${stamp}.csv"`,
  );
  res.send(csv);
});
