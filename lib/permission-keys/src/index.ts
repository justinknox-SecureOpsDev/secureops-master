/**
 * Single source of truth for the WCSG custom-role permission registry.
 *
 * This is a SEPARATE axis from the feature-flag system (lib/feature-keys):
 * feature flags gate whole product surfaces per-deployment (paid tiers),
 * while permission keys gate which *roles* may use a module/action within
 * a deployment, and are admin-editable at runtime with no redeploy.
 *
 * Shape mirrors the feature-flag registry on purpose: a canonical key list
 * here, a DB override table (`permission_overrides`), and an in-memory
 * cache refreshed on write (see artifacts/api-server/src/lib/permissions.ts).
 *
 * Scope (matches Task #733 — do not expand without a fresh task):
 *   Scheduling, Time & Attendance, Finance/Accounting transactions,
 *   Personnel, Dispatch. Everything else keeps its existing hardcoded role
 *   middleware.
 *
 * `defaultAllowedRoles` MUST reproduce today's hardcoded behavior exactly —
 * it is what every deployment effectively runs until an admin deliberately
 * changes a toggle on the Permissions page.
 *
 * The `admin` role is always implicitly allowed and can never be removed
 * from a key's allowed-roles set (enforced in
 * artifacts/api-server/src/routes/permissions.ts) so a mis-click can never
 * lock every admin out of the system.
 */

export const ASSIGNABLE_ROLES = ["admin", "dispatcher", "employee", "site_manager"] as const;
export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

export type PermissionArea =
  | "scheduling"
  | "timeAttendance"
  | "finance"
  | "personnel"
  | "dispatch";

export interface PermissionKeyDef {
  key: string;
  area: PermissionArea;
  areaLabel: string;
  label: string;
  description: string;
  /** Reproduces the pre-existing hardcoded role gate for this action. */
  defaultAllowedRoles: readonly AssignableRole[];
}

export const PERMISSION_KEY_DEFS: readonly PermissionKeyDef[] = [
  {
    key: "scheduling.manage",
    area: "scheduling",
    areaLabel: "Scheduling",
    label: "Create & edit shifts",
    description: "Create, edit, and manage the shift roster (previously admin + site manager only).",
    defaultAllowedRoles: ["admin", "site_manager"],
  },
  {
    key: "timeAttendance.manage",
    area: "timeAttendance",
    areaLabel: "Time & Attendance",
    label: "Edit & approve time entries",
    description: "Correct clock times and approve officer time entries (previously admin + site manager only).",
    defaultAllowedRoles: ["admin", "site_manager"],
  },
  {
    key: "personnel.manage",
    area: "personnel",
    areaLabel: "Personnel",
    label: "Manage employee records",
    description:
      "Create new employee/staff accounts, edit another employee's record, and deactivate an employee (previously admin only). Editing one's own record is never gated by this permission.",
    defaultAllowedRoles: ["admin"],
  },
  {
    key: "dispatch.manage",
    area: "dispatch",
    areaLabel: "Dispatch",
    label: "Dispatch command center",
    description:
      "Assign officers to open shifts and notify eligible officers about a shift vacancy, from the dispatch board (previously admin + dispatcher only).",
    defaultAllowedRoles: ["admin", "dispatcher"],
  },
  {
    key: "finance.transactions",
    area: "finance",
    areaLabel: "Finance / Accounting",
    label: "Create, edit & send invoices and payroll entries",
    description:
      "Day-to-day transactional bookkeeping — create/edit/send a single invoice or payroll entry (previously admin only). This is distinct from the company-owner flag, which gates the aggregate financial dashboards, not individual transactions.",
    defaultAllowedRoles: ["admin"],
  },
] as const;

export const PERMISSION_KEYS = PERMISSION_KEY_DEFS.map((d) => d.key) as readonly string[];
export type PermissionKey = (typeof PERMISSION_KEY_DEFS)[number]["key"];

export function getPermissionKeyDef(key: string): PermissionKeyDef | undefined {
  return PERMISSION_KEY_DEFS.find((d) => d.key === key);
}
