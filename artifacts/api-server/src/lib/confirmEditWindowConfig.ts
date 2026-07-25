/**
 * Officer time-edit window configuration — in-memory singleton.
 *
 * Controls how far (in hours) an officer may move their own clock-in/out from
 * the recorded time during post-shift confirmation.
 *
 * Precedence (highest first), resolved in
 * `routes/timeEntries.ts getConfirmEditWindowHours()`:
 *   1. DB override — `platform_customer_config.time_confirm_edit_window_hours`
 *      (singleton row), editable live from the super-admin Platform page.
 *   2. `TIME_CONFIRM_EDIT_WINDOW_HOURS` env var.
 *   3. 2h default.
 *
 * Call `loadConfirmEditWindowConfigFromDb()` at boot and
 * `applyConfirmEditWindowConfig(row)` after every PUT
 * /admin/platform/customer-config.
 */
import { eq } from "drizzle-orm";
import { db, platformCustomerConfigTable } from "@workspace/db";

let _override: number | null = null;

/** Current DB override in hours, or null when unset (fall back to env/default). */
export function getConfirmEditWindowOverride(): number | null {
  return _override;
}

/** Parse + validate a raw override value; returns null on unset/invalid. */
function parseOverride(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

export function applyConfirmEditWindowConfig(
  row: { timeConfirmEditWindowHours?: string | null } | null | undefined,
): void {
  _override = parseOverride(row?.timeConfirmEditWindowHours);
}

export async function loadConfirmEditWindowConfigFromDb(): Promise<void> {
  try {
    const [row] = await db
      .select({
        timeConfirmEditWindowHours: platformCustomerConfigTable.timeConfirmEditWindowHours,
      })
      .from(platformCustomerConfigTable)
      .where(eq(platformCustomerConfigTable.id, "singleton"))
      .limit(1);
    applyConfirmEditWindowConfig(row ?? null);
  } catch {
    // Table missing (pre-push) or transient DB error — keep env/default.
  }
}
