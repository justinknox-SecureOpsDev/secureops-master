/**
 * Processing-fee configuration — in-memory singleton.
 *
 * Storage: `platform_customer_config` (id = 'singleton').
 *   processingFeeEnabled  boolean  — whether to add the fee to invoices
 *   processingFeeRate     text     — percentage string, e.g. "8.25"
 *
 * Env defaults (applied at boot, overridden by DB values):
 *   PROCESSING_FEE_ENABLED  "true" | "false"  (default: "false")
 *   PROCESSING_FEE_RATE      numeric string    (default: "8.25")
 *
 * Call `loadProcessingFeeConfigFromDb()` at boot and
 * `applyProcessingFeeConfig(row)` after every PUT /admin/platform/customer-config.
 */
import { eq } from "drizzle-orm";
import { db, platformCustomerConfigTable } from "@workspace/db";

const DEFAULT_ENABLED = (process.env["PROCESSING_FEE_ENABLED"] ?? "false") === "true";
const DEFAULT_RATE = Math.max(0, parseFloat(process.env["PROCESSING_FEE_RATE"] ?? "8.25") || 8.25);

let _enabled = DEFAULT_ENABLED;
let _rate = DEFAULT_RATE;

export function isProcessingFeeEnabled(): boolean {
  return _enabled;
}

export function getProcessingFeeRate(): number {
  return _rate;
}

export function applyProcessingFeeConfig(
  row: { processingFeeEnabled?: boolean | null; processingFeeRate?: string | null } | null | undefined,
): void {
  _enabled = DEFAULT_ENABLED;
  _rate = DEFAULT_RATE;
  if (!row) return;
  if (row.processingFeeEnabled !== null && row.processingFeeEnabled !== undefined) {
    _enabled = row.processingFeeEnabled;
  }
  if (row.processingFeeRate !== null && row.processingFeeRate !== undefined && row.processingFeeRate !== "") {
    const parsed = parseFloat(row.processingFeeRate);
    if (isFinite(parsed) && parsed > 0) _rate = parsed;
  }
}

export async function loadProcessingFeeConfigFromDb(): Promise<void> {
  try {
    const [row] = await db
      .select({
        processingFeeEnabled: platformCustomerConfigTable.processingFeeEnabled,
        processingFeeRate: platformCustomerConfigTable.processingFeeRate,
      })
      .from(platformCustomerConfigTable)
      .where(eq(platformCustomerConfigTable.id, "singleton"))
      .limit(1);
    applyProcessingFeeConfig(row ?? null);
  } catch {
    // Table missing (pre-push) or transient DB error — keep env defaults.
  }
}
