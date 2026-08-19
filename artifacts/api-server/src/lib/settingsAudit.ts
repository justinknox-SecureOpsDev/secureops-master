/**
 * Helpers for emitting human-readable old→new metadata on privileged
 * settings changes (customer/plan config, brand overrides, feature flags).
 *
 * The generic auditLogMiddleware records these PUTs as `admin.action` and
 * persists whatever the handler stashes on `res.locals.auditMetadata` into
 * `audit_logs.metadata`. This module produces a stable, presentational
 * `{ settingsChange, changes: [...] }` shape the admin-portal Audit Log page
 * renders as friendly before/after lines — so reviewers never have to read raw
 * JSON to see who changed what.
 *
 * The `kind` hint tells the client how to format each value (money, percent,
 * hours, colour, boolean, image-set, or plain text). Values are always the raw
 * (already non-sensitive) config values EXCEPT for images, where we deliberately
 * emit only a "set"/"unset" boolean so a multi-hundred-KB base64 logo never
 * lands in the audit row.
 */

export type SettingsChangeKind =
  | "text"
  | "number"
  | "minutes"
  | "money_cents"
  | "percent"
  | "hours"
  | "bool"
  | "color"
  | "image"
  | "feature";

export type SettingChange = {
  field: string;
  label: string;
  kind: SettingsChangeKind;
  old: unknown;
  new: unknown;
};

export type SettingsChangeMetadata = {
  settingsChange: "customer_config" | "brand" | "features";
  changes: SettingChange[];
};

type FieldDescriptor = { field: string; label: string; kind: SettingsChangeKind };

const CUSTOMER_CONFIG_FIELDS: FieldDescriptor[] = [
  { field: "customerName", label: "Customer name", kind: "text" },
  { field: "planTier", label: "Plan tier", kind: "text" },
  { field: "monthlyPriceCents", label: "Monthly price", kind: "money_cents" },
  { field: "officerCount", label: "Officer count", kind: "number" },
  { field: "billingNotes", label: "Billing notes", kind: "text" },
  { field: "planStartDate", label: "Plan start date", kind: "text" },
  { field: "timeConfirmEditWindowHours", label: "Time-edit limit", kind: "hours" },
  { field: "autoClockOutDelayMinutes", label: "Auto clock-out delay", kind: "minutes" },
];

const BRAND_FIELDS: FieldDescriptor[] = [
  { field: "companyName", label: "Company name", kind: "text" },
  { field: "shortName", label: "Short name", kind: "text" },
  { field: "tagline", label: "Tagline", kind: "text" },
  { field: "companyLicense", label: "Company license #", kind: "text" },
  { field: "appName", label: "App name", kind: "text" },
  { field: "colorNavy", label: "Primary colour", kind: "color" },
  { field: "colorGold", label: "Accent colour", kind: "color" },
  { field: "colorCream", label: "Cream colour", kind: "color" },
  { field: "billingEmail", label: "Billing email", kind: "text" },
  { field: "hrEmail", label: "HR email", kind: "text" },
  { field: "adminNotifyEmail", label: "Admin-notify email", kind: "text" },
  { field: "backgroundCheckAdminUserId", label: "Background-check admin", kind: "text" },
  { field: "logoDataUrl", label: "Logo", kind: "image" },
];

/** Treats `undefined` and `null` as equal; everything else compared with `===`. */
function equalish(a: unknown, b: unknown): boolean {
  const an = a === undefined ? null : a;
  const bn = b === undefined ? null : b;
  return an === bn;
}

function diff(
  fields: FieldDescriptor[],
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): SettingChange[] {
  const changes: SettingChange[] = [];
  for (const { field, label, kind } of fields) {
    // A field absent from the incoming payload means "leave unchanged" for the
    // .optional() keys — skip it entirely so we never report a spurious change.
    if (!(field in after)) continue;
    let oldVal = before[field] ?? null;
    let newVal = after[field] ?? null;
    if (kind === "image") {
      // Never persist the base64 blob — record set/unset only.
      oldVal = oldVal != null && oldVal !== "";
      newVal = newVal != null && newVal !== "";
    }
    if (!equalish(oldVal, newVal)) {
      changes.push({ field, label, kind, old: oldVal, new: newVal });
    }
  }
  return changes;
}

export function buildCustomerConfigChanges(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): SettingsChangeMetadata | null {
  const changes = diff(CUSTOMER_CONFIG_FIELDS, before, after);
  if (changes.length === 0) return null;
  return { settingsChange: "customer_config", changes };
}

export function buildBrandChanges(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): SettingsChangeMetadata | null {
  const changes = diff(BRAND_FIELDS, before, after);
  if (changes.length === 0) return null;
  return { settingsChange: "brand", changes };
}

/**
 * Builds feature-flag change entries. `before`/`after` map each touched key to
 * its effective enabled state (true/false).
 */
export function buildFeatureChanges(
  entries: Array<{ key: string; old: boolean; new: boolean }>,
): SettingsChangeMetadata | null {
  const changes: SettingChange[] = entries
    .filter((e) => e.old !== e.new)
    .map((e) => ({ field: e.key, label: e.key, kind: "feature", old: e.old, new: e.new }));
  if (changes.length === 0) return null;
  return { settingsChange: "features", changes };
}
