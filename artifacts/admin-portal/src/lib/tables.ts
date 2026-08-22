/**
 * Table descriptors drive the entire generic admin UI: sidebar list, grid
 * columns, edit form, FK dropdowns, Excel import column mapping, and template
 * .xlsx download. Keep this aligned with `lib/db/src/schema/*` and the server's
 * `/admin/tables/:table` endpoint registry in `artifacts/api-server/src/routes/admin.ts`.
 */

import type { FeatureKey } from "@/lib/brand";

/** Singularize a plural label for "Add {X}" / "Edit {X}" buttons. */
export function singularize(label: string): string {
  if (/ies$/i.test(label)) return label.replace(/ies$/i, "y");
  if (/sses$/i.test(label)) return label.replace(/es$/i, "");
  if (/s$/i.test(label) && !/ss$/i.test(label)) return label.replace(/s$/i, "");
  return label;
}

export type FieldType =
  | "text"
  | "textarea"
  | "email"
  | "number"
  | "integer"
  | "date"
  | "datetime"
  | "boolean"
  | "select"
  | "fk"
  | "password"
  | "json"
  /** Object-storage path (e.g. "/objects/uploads/abc"). Renders as an "Open" link
   *  in the grid + dialog using a short-lived signed URL. */
  | "fileKey"
  /** Multi-file: array of object-storage paths stored as JSONB. */
  | "fileKeyList";

export type Field = {
  key: string;
  label: string;
  type: FieldType;
  /** Required on create. */
  required?: boolean;
  /** Hidden in the create/edit form (still shown in grid). */
  readonly?: boolean;
  /** Hidden in the grid by default. */
  hiddenInGrid?: boolean;
  /** Enum options for select. */
  options?: { label: string; value: string }[];
  /** FK target table name (must match a key in TABLES). */
  fkTable?: string;
  /** FK display field on the foreign row. */
  fkLabel?: string;
  placeholder?: string;
  /** UI-only field: not sent to the API, used to drive auto-fill of other fields. */
  virtual?: boolean;
  /** When this (virtual fk) field changes, copy these props from the picked row into the form. Map: targetFormKey -> fkRowKey. */
  autofill?: Record<string, string>;
  /** Restrict FK options to rows where row[fkRowKey] === current form value at formKey. */
  filterBy?: { fkRowKey: string; formKey: string };
  /** During Excel import, resolve a free-text value (e.g. site name) to an FK id by looking up the FK table's primaryLabelField. */
  importResolveByLabel?: boolean;
  /** Override the "Match by …" label shown in the import wizard for THIS field
   *  (defaults to the FK target's match-by-label fields). */
  importMatchLabel?: string;
  /** Override the client-side label key extractor for THIS field. When set,
   *  the wizard skips composite-key UI and uses this single normalized key
   *  for matching against the FK target rows. The server's altPrimaryKeys
   *  must register the same normalized key for the resolution to align. */
  importMatchKeyFn?: (row: any) => string;
  /** Optional section header label rendered above this field in the row dialog.
   *  Lets long forms (e.g. employees) be visually grouped (Identity / Licence / Pay …). */
  section?: string;
  /** Sample value written into the second row of the downloadable XLSX
   *  template so admins can see the expected format. Falls back to a
   *  generic per-type sample when omitted. Ignored entirely for field
   *  types that aren't supported by Excel import (e.g. file uploads). */
  importExample?: string;
  /** Descriptive text rendered below the field in the edit dialog. */
  helpText?: string;
  /** Plan feature this field belongs to. When the deployment's plan doesn't
   *  include it, the field is skipped everywhere: grid column, edit dialog,
   *  and Excel import (template + mapping + write). Unlike `TABLE_FEATURE`
   *  (which gates an entire table/route), this hides a single field within
   *  an otherwise-ungated table. */
  feature?: FeatureKey;
  /** Grid-only computed column. The field is automatically skipped by the
   *  row edit dialog, the import wizard (template + mapping + write paths)
   *  and never sent to the API. The grid renders it by resolving `fromField`
   *  (an FK key on the same row) against its target table and passing the
   *  matched row to `render`. Returning an empty string falls back to "—". */
  derived?: {
    /** Key of an FK field on the same descriptor whose row supplies the data. */
    fromField: string;
    /** Build the cell label from the resolved FK row (null when unmatched). */
    render: (fkRow: Record<string, unknown> | null) => string;
    /**
     * Optional click target. When set, the derived cell renders as a link to
     * `/tables/{table}?filter[{filterField}]={fkValue}` so admins can drill
     * into the related record from any grid that resolves to it.
     */
    linkTo?: { table: string; filterField: string };
    /**
     * Optional direct-route click target, built from the resolved fk value.
     * When set it takes precedence over `linkTo`, so the cell links straight to
     * an app route (e.g. an employee's officer profile) instead of a grid
     * filter. Return value is a wouter route under the portal base.
     */
    linkRoute?: (fkValue: string) => string;
  };
};

export type TableDescriptor = {
  /** URL slug + admin/tables/:table key. */
  name: string;
  /** Sidebar/page label. */
  label: string;
  /** Plural noun used in messages. */
  plural: string;
  /** Whether the import wizard is supported (server-side allowlist). */
  importSupported: boolean;
  /** Field that best identifies a row (used for FK dropdown labels, Excel
   *  import label-matching, and template generation). */
  primaryLabelField: string;
  /** Optional display-only override for FK dropdown / grid labels. When set,
   *  takes precedence over `primaryLabelField` for *rendering* in
   *  `useFkOptions` (and therefore the grid FK cell, row-form FK select, and
   *  import wizard FK picker). Import label-matching still uses
   *  `primaryLabelField` / `importMatchByLabelFields`, so existing Excel
   *  imports keep working. */
  primaryLabelFn?: (row: Record<string, unknown>) => string;
  /**
   * When this table is referenced as a foreign key and the importer chooses
   * "match by label" instead of "match by ID", these are the columns whose
   * combined values uniquely identify a row. Defaults to [primaryLabelField].
   * For shifts the title alone is rarely unique, so we use [title, startTime].
   */
  importMatchByLabelFields?: string[];
  fields: Field[];
};

/** Resolved list of label fields used for free-text FK matching during import. */
export function getImportMatchByLabelFields(t: TableDescriptor): string[] {
  return t.importMatchByLabelFields && t.importMatchByLabelFields.length > 0
    ? t.importMatchByLabelFields
    : [t.primaryLabelField];
}

export const TABLES: TableDescriptor[] = [
  {
    name: "sales_leads",
    label: "Sales Leads",
    plural: "sales leads",
    importSupported: false,
    primaryLabelField: "companyName",
    fields: [
      { key: "id", label: "ID", type: "text", readonly: true, hiddenInGrid: true },
      { key: "companyName", label: "Company", type: "text", required: true },
      { key: "contactName", label: "Contact", type: "text", required: true },
      { key: "email", label: "Email", type: "email", required: true },
      { key: "phone", label: "Phone", type: "text" },
      { key: "tier", label: "Interested Tier", type: "text" },
      { key: "officerCount", label: "Officer Count", type: "integer" },
      {
        key: "status", label: "Status", type: "select", required: true,
        options: [
          { label: "New", value: "new" },
          { label: "Contacted", value: "contacted" },
          { label: "Qualified", value: "qualified" },
          { label: "Won", value: "won" },
          { label: "Lost", value: "lost" },
          { label: "Converted", value: "converted" },
        ],
      },
      { key: "source", label: "Source", type: "text", hiddenInGrid: true },
      { key: "message", label: "Message", type: "textarea", hiddenInGrid: true },
      { key: "adminNotes", label: "Admin Notes", type: "textarea", hiddenInGrid: true },
      { key: "convertedClientId", label: "Client", type: "fk", fkTable: "clients", fkLabel: "name", readonly: true, hiddenInGrid: true },
      { key: "convertedAt", label: "Converted", type: "datetime", readonly: true },
      { key: "createdAt", label: "Submitted", type: "datetime", readonly: true },
      { key: "updatedAt", label: "Updated", type: "datetime", readonly: true, hiddenInGrid: true },
    ],
  },
  {
    name: "payment_discrepancies",
    label: "Payment Discrepancies",
    plural: "payment discrepancies",
    importSupported: false,
    primaryLabelField: "description",
    fields: [
      { key: "id", label: "ID", type: "text", readonly: true, hiddenInGrid: true },
      { key: "employeeId", label: "Officer", type: "fk", fkTable: "users", fkLabel: "email", required: true },
      {
        key: "discrepancyType", label: "Type", type: "select", required: true,
        options: [
          { label: "Missed payment", value: "missed_payment" },
          { label: "Underpaid", value: "underpaid" },
          { label: "Missing hours", value: "missing_hours" },
          { label: "Incorrect rate", value: "incorrect_rate" },
          { label: "Other", value: "other" },
        ],
      },
      {
        key: "status", label: "Status", type: "select", required: true,
        options: [
          { label: "Open", value: "open" },
          { label: "Under review", value: "under_review" },
          { label: "Resolved", value: "resolved" },
        ],
      },
      { key: "payPeriodStart", label: "Pay Period Start", type: "date", hiddenInGrid: true },
      { key: "payPeriodEnd", label: "Pay Period End", type: "date", hiddenInGrid: true },
      { key: "shiftDate", label: "Shift Date", type: "date" },
      { key: "expectedAmount", label: "Expected ($)", type: "text" },
      { key: "receivedAmount", label: "Received ($)", type: "text" },
      { key: "description", label: "Description", type: "textarea", required: true },
      { key: "adminNotes", label: "Admin Notes", type: "textarea", hiddenInGrid: true },
      { key: "resolvedAt", label: "Resolved At", type: "datetime", hiddenInGrid: true },
      { key: "createdAt", label: "Submitted", type: "datetime", readonly: true },
      { key: "updatedAt", label: "Updated", type: "datetime", readonly: true, hiddenInGrid: true },
    ],
  },
  {
    name: "users",
    label: "Users",
    plural: "users",
    importSupported: true,
    primaryLabelField: "email",
    primaryLabelFn: (r) => {
      const first = String(r.firstName ?? "").trim();
      const last = String(r.lastName ?? "").trim();
      const full = [first, last].filter(Boolean).join(" ");
      const email = String(r.email ?? "").trim();
      if (full && email) return `${full} (${email})`;
      return full || email;
    },
    fields: [
      { key: "id", label: "ID", type: "text", readonly: true, hiddenInGrid: true },
      { key: "email", label: "Email", type: "email", required: true },
      { key: "password", label: "Password", type: "password", hiddenInGrid: true, placeholder: "min 6 chars (leave blank to keep)" },
      { key: "firstName", label: "First Name", type: "text", required: true },
      { key: "lastName", label: "Last Name", type: "text", required: true },
      {
        key: "role", label: "Role", type: "select", required: true,
        options: [
          { label: "Admin", value: "admin" },
          { label: "Dispatcher", value: "dispatcher" },
          { label: "Site Manager", value: "site_manager" },
          { label: "Employee", value: "employee" },
        ],
      },
      {
        key: "status", label: "Status", type: "select", required: true,
        options: [
          { label: "Active", value: "active" },
          { label: "Inactive", value: "inactive" },
          { label: "Pending", value: "pending" },
        ],
      },
      { key: "expoPushToken", label: "Push Token", type: "text", hiddenInGrid: true },
      { key: "appVersion", label: "App Version", type: "text", readonly: true, hiddenInGrid: true },
      { key: "appPlatform", label: "App Platform", type: "text", readonly: true, hiddenInGrid: true },
      { key: "appReportedAt", label: "App Last Seen", type: "datetime", readonly: true, hiddenInGrid: true },
      { key: "appUpdateNotifiedAt", label: "Update Notice Sent", type: "datetime", readonly: true, hiddenInGrid: true },
      { key: "phoneNumber", label: "SMS Phone (E.164)", type: "text", importExample: "+15125550142" },
      { key: "smsOptIn", label: "SMS Notifications", type: "boolean" },
      { key: "lastActiveAt", label: "Last Active", type: "datetime", readonly: true },
      { key: "createdAt", label: "Created", type: "datetime", readonly: true },
    ],
  },
  {
    name: "employees",
    label: "Employees",
    plural: "employees",
    importSupported: true,
    primaryLabelField: "phone",
    fields: [
      { key: "id", label: "ID", type: "text", readonly: true, hiddenInGrid: true, section: "Identity" },
      {
        key: "__name", label: "Name", type: "text", readonly: true,
        derived: {
          fromField: "userId",
          render: (u) => {
            if (!u) return "";
            const first = String(u.firstName ?? "").trim();
            const last = String(u.lastName ?? "").trim();
            const full = [first, last].filter(Boolean).join(" ");
            return full || String(u.email ?? "").trim();
          },
          linkRoute: (userId) => `/personnel/${encodeURIComponent(userId)}`,
        },
      },
      { key: "userId", label: "User", type: "fk", fkTable: "users", fkLabel: "email", required: true, section: "Identity", importResolveByLabel: true, importExample: "name@example.com" },
      {
        key: "position", label: "Position", type: "select", section: "Identity",
        options: [
          { label: "Officer (licensed)", value: "officer" },
          { label: "Support staff (no licence)", value: "support_staff" },
        ],
        importExample: "officer",
      },
      // --- Contact ---
      { key: "phone", label: "Phone", type: "text", section: "Contact & Identity", importExample: "+1 512 555 0142" },
      { key: "address", label: "Address", type: "textarea", hiddenInGrid: true, importExample: "123 Main St, Austin, TX 78701" },
      { key: "dateOfBirth", label: "Date of Birth", type: "date", hiddenInGrid: true, importExample: "1990-04-12" },
      { key: "cityOfBirth", label: "City of Birth", type: "text", hiddenInGrid: true, importExample: "Houston" },
      { key: "stateOfBirth", label: "State of Birth", type: "text", hiddenInGrid: true, importExample: "TX" },
      // --- Right to work ---
      { key: "rightToWorkStatus", label: "Right to Work", type: "text", hiddenInGrid: true, section: "Right to Work", importExample: "US Citizen" },
      { key: "rightToWorkDocKey", label: "Right-to-Work Doc", type: "fileKey", hiddenInGrid: true },
      // --- TX Security License (visible — admins must update this) ---
      { key: "siaLicenseNumber", label: "Licence #", type: "text", section: "TX Security Licence", importExample: "TX-SEC-123456" },
      {
        key: "siaLicenseLevel", label: "Licence Level", type: "select",
        options: [
          { label: "Level 1 (Support Staff)", value: "1" },
          { label: "Level 2 (unarmed)", value: "2" },
          { label: "Level 3 (armed)", value: "3" },
          { label: "Level 4 (PPO)", value: "4" },
        ],
      },
      { key: "siaLicenseExpiry", label: "Licence Expiry", type: "date", importExample: "2027-06-30" },
      { key: "licenseDocKey", label: "Licence Doc", type: "fileKey" },
      { key: "passportDocKey", label: "Passport Doc", type: "fileKey", hiddenInGrid: true },
      // --- Experience ---
      { key: "yearsExperience", label: "Years Exp.", type: "integer", hiddenInGrid: true, section: "Experience & References", importExample: "5" },
      { key: "previousExperience", label: "Previous Experience", type: "textarea", hiddenInGrid: true, importExample: "3 years event security at Acme Stadium" },
      { key: "references", label: "References", type: "json", hiddenInGrid: true, importExample: '[{"name":"Jane Doe","phone":"+1 512 555 0199","relationship":"Former supervisor"}]' },
      // --- Personal docs ---
      { key: "photoKey", label: "Photo", type: "fileKey", hiddenInGrid: true, section: "Personal Documents" },
      { key: "cvKey", label: "Resume", type: "fileKey", hiddenInGrid: true },
      { key: "trainingCertificateKeys", label: "Training Certificates", type: "fileKeyList", hiddenInGrid: true },
      { key: "availability", label: "Weekly Availability", type: "json", hiddenInGrid: true, feature: "availability", importExample: '{"mon":["am","pm"],"tue":["pm"],"wed":[],"thu":["am","pm","night"],"fri":["night"],"sat":["pm","night"],"sun":[]}' },
      // --- Emergency contact ---
      { key: "emergencyContactName", label: "Emergency Contact", type: "text", hiddenInGrid: true, section: "Emergency Contact", importExample: "John Doe" },
      { key: "emergencyContactRelationship", label: "Emergency Relationship", type: "text", hiddenInGrid: true, importExample: "Spouse" },
      { key: "emergencyContactPhone", label: "Emergency Phone", type: "text", hiddenInGrid: true, importExample: "+1 512 555 0177" },
      // --- Pay & banking ---
      { key: "hourlyRate", label: "Hourly Rate ($)", type: "number", section: "Pay & Banking", importExample: "22.50" },
      { key: "bankAccountName", label: "Bank Acct Name", type: "text", hiddenInGrid: true, importExample: "Jane M Smith" },
      { key: "bankAccountNumber", label: "Bank Acct #", type: "text", hiddenInGrid: true, importExample: "000123456789" },
      { key: "bankBsb", label: "Routing/Sort Code", type: "text", hiddenInGrid: true, importExample: "111000025" },
      { key: "niNumber", label: "SSN (last 4)", type: "text", hiddenInGrid: true, importExample: "1234" },
      { key: "taxCode", label: "Tax Code", type: "text", hiddenInGrid: true, importExample: "S-0" },
      { key: "payStubDocKey", label: "W-2 / Pay Stub", type: "fileKey", hiddenInGrid: true },
      // --- Uniform sizes ---
      { key: "uniformShirt", label: "Uniform Shirt", type: "text", hiddenInGrid: true, section: "Uniform Sizes", importExample: "L" },
      { key: "uniformTrousers", label: "Uniform Trousers", type: "text", hiddenInGrid: true, importExample: "34x32" },
      { key: "uniformJacket", label: "Uniform Jacket", type: "text", hiddenInGrid: true, importExample: "L" },
      { key: "uniformBoots", label: "Uniform Boots", type: "text", hiddenInGrid: true, importExample: "10" },
      // --- Consents & acknowledgements ---
      { key: "directDepositConsent", label: "Direct Deposit Consent", type: "boolean", hiddenInGrid: true, section: "Consents & Policy Acknowledgements", importExample: "true" },
      { key: "directDepositSignature", label: "Direct Deposit Signature", type: "text", hiddenInGrid: true, importExample: "Jane M Smith" },
      { key: "acknowledgements", label: "Policy Acknowledgements", type: "json", hiddenInGrid: true, importExample: '{"drugFree":true,"uniform":true,"nda":true,"contract":true}' },
      // --- HR pipeline links (read-only) ---
      { key: "applicationId", label: "Application", type: "text", readonly: true, hiddenInGrid: true, section: "HR Pipeline (read-only)" },
      { key: "onboardingSubmissionId", label: "Onboarding Submission", type: "text", readonly: true, hiddenInGrid: true },
      { key: "createdAt", label: "Created", type: "datetime", readonly: true, hiddenInGrid: true },
    ],
  },
  {
    name: "clients",
    label: "Clients",
    plural: "clients",
    importSupported: true,
    primaryLabelField: "name",
    fields: [
      { key: "id", label: "ID", type: "text", readonly: true, hiddenInGrid: true },
      { key: "name", label: "Name", type: "text", required: true },
      { key: "contactName", label: "Contact Name", type: "text" },
      { key: "contactEmail", label: "Contact Email", type: "email" },
      { key: "contactPhone", label: "Contact Phone", type: "text" },
      { key: "billingAddress", label: "Billing Address", type: "textarea" },
      { key: "paymentTermsDays", label: "Payment Terms (days)", type: "integer", required: true },
      {
        key: "billingCycle", label: "Billing Cycle", type: "select",
        options: [
          { label: "Weekly (auto-sync)", value: "weekly" },
          { label: "Bi-weekly", value: "biweekly" },
          { label: "Semi-monthly (1st–15th / 16th–end)", value: "semi_monthly" },
          { label: "Monthly", value: "monthly" },
          { label: "Custom", value: "custom" },
        ],
        helpText: "Weekly clients have invoices auto-generated each ISO week. All other cycles require manual generation via '+ New Invoice' on the Invoice Board.",
      },
      { key: "notes", label: "Notes", type: "textarea", hiddenInGrid: true },
      { key: "contractDocKey", label: "Contract", type: "fileKey", hiddenInGrid: true, helpText: "Signed contract PDF or document for this client." },
      { key: "createdAt", label: "Created", type: "datetime", readonly: true },
    ],
  },
  {
    name: "sites",
    label: "Sites",
    plural: "sites",
    importSupported: true,
    primaryLabelField: "name",
    fields: [
      { key: "id", label: "ID", type: "text", readonly: true, hiddenInGrid: true },
      { key: "clientId", label: "Client", type: "fk", fkTable: "clients", fkLabel: "name", required: true },
      { key: "name", label: "Name", type: "text", required: true },
      {
        key: "status", label: "Status", type: "select",
        options: [
          { label: "Active", value: "active" },
          { label: "Inactive", value: "inactive" },
        ],
        helpText: "Inactive retires the site: it disappears from shift/clock-in pickers and blocks new shifts, but all history (shifts, invoices, payroll, patrol) stays intact. Use instead of delete.",
      },
      { key: "address", label: "Address", type: "textarea" },
      { key: "defaultBillRate", label: "Bill Rate ($/hr)", type: "number" },
      { key: "locationLat", label: "Lat", type: "number", hiddenInGrid: true },
      { key: "locationLng", label: "Lng", type: "number", hiddenInGrid: true },
      {
        key: "geofenceRadiusMiles",
        label: "Geofence radius (mi) — leave blank to use global default",
        type: "number",
        hiddenInGrid: true,
        placeholder: "e.g. 0.5 for a sprawling industrial park",
      },
      {
        key: "autoClockOutEnabled",
        label: "Auto clock-out",
        type: "boolean",
        hiddenInGrid: true,
        helpText: "When enabled, officers at this site are automatically clocked out after their shift ends and they leave the geofence. Disable for sites where officers routinely work past scheduled end times.",
      },
      {
        key: "autoClockOutDelayMinutes",
        label: "Auto clock-out delay (minutes) — leave blank for company default",
        type: "integer",
        hiddenInGrid: true,
        placeholder: "e.g. 45 for an event post",
        helpText: "How long past the scheduled shift end the system waits before closing an abandoned entry, if the officer can't be confirmed inside the geofence. Blank uses the company default (10 minutes if that is also blank); max 720 (12h).",
      },
      {
        key: "autoClockOutPayGrace",
        label: "Pay the grace period",
        type: "boolean",
        hiddenInGrid: true,
        helpText: "PAYROLL IMPACT: when enabled, an auto-closed entry is stamped at the scheduled end PLUS the delay above, so the officer is paid (and the client billed) for the whole wait. Off — the default — stamps the clock-out at the scheduled shift end and the wait is unpaid.",
      },
      {
        key: "autoClockInEnabled",
        label: "Auto clock-in",
        type: "boolean",
        hiddenInGrid: true,
        helpText: "When enabled, officers with an accepted shift here are automatically clocked in — no tap needed — once their shift starts and the app (open in the foreground) detects them inside the geofence. Off by default.",
      },
      {
        key: "processingFeeEnabled",
        label: "Charge processing fee",
        type: "boolean",
        hiddenInGrid: true,
        helpText: "When enabled, the configured processing fee rate is applied to this site's invoices automatically.",
      },
      {
        key: "processingFeeRate",
        label: "Processing fee rate (%)",
        type: "number",
        hiddenInGrid: true,
        placeholder: "8.25",
        helpText: "Percentage applied to the invoice subtotal when the processing fee is enabled (e.g. 8.25 for 8.25%).",
      },
      { key: "notes", label: "Notes", type: "textarea", hiddenInGrid: true },
      { key: "createdAt", label: "Created", type: "datetime", readonly: true },
    ],
  },
  {
    name: "shifts",
    label: "Shifts",
    plural: "shifts",
    importSupported: true,
    primaryLabelField: "title",
    // FK dropdowns (e.g. "Add shift assignment") show the title alone, which is
    // ambiguous when the same post repeats daily. Append the start date + time
    // so the admin can tell which occurrence they're assigning.
    primaryLabelFn: (row) => {
      const title = String(row.title ?? "").trim();
      const start = row.startTime ? new Date(String(row.startTime)) : null;
      if (!start || Number.isNaN(start.getTime())) return title;
      const when = start.toLocaleString("en-US", {
        weekday: "short", month: "short", day: "numeric",
        hour: "numeric", minute: "2-digit",
      });
      return title ? `${title} — ${when}` : when;
    },
    importMatchByLabelFields: ["title", "startTime"],
    fields: [
      { key: "id", label: "ID", type: "text", readonly: true, hiddenInGrid: true },
      { key: "title", label: "Title", type: "text", required: true },
      { key: "siteId", label: "Site", type: "fk", fkTable: "sites", fkLabel: "name" },
      { key: "startTime", label: "Start", type: "datetime", required: true },
      { key: "endTime", label: "End", type: "datetime", required: true },
      { key: "payRate", label: "Pay Rate ($)", type: "number", required: true },
      { key: "billRate", label: "Bill Rate ($)", type: "number", required: true },
      {
        key: "requiredLicenseLevel", label: "Min Licence", type: "select", required: true,
        options: [
          { label: "Support (no licence)", value: "1" },
          { label: "Level 2 (unarmed)", value: "2" },
          { label: "Level 3 (armed)", value: "3" },
          { label: "Level 4 (PPO)", value: "4" },
        ],
      },
      { key: "headcount", label: "Headcount", type: "integer", required: true },
      {
        key: "status", label: "Status", type: "select",
        options: [
          { label: "Upcoming", value: "upcoming" },
          { label: "Active", value: "active" },
          { label: "Completed", value: "completed" },
          { label: "Cancelled", value: "cancelled" },
        ],
      },
      {
        key: "shiftType", label: "Shift Type", type: "select",
        options: [
          { label: "Standard", value: "standard" },
          { label: "PPO / Protection Detail", value: "ppo_detail" },
        ],
      },
      { key: "notes", label: "Notes", type: "textarea", hiddenInGrid: true },
      { key: "createdAt", label: "Created", type: "datetime", readonly: true },
    ],
  },
  {
    name: "shift_assignments",
    label: "Shift Assignments",
    plural: "shift assignments",
    importSupported: true,
    primaryLabelField: "id",
    fields: [
      { key: "id", label: "ID", type: "text", readonly: true, hiddenInGrid: true },
      {
        key: "__name", label: "Name", type: "text", readonly: true,
        derived: {
          fromField: "employeeId",
          render: (u) => {
            if (!u) return "";
            const first = String(u.firstName ?? "").trim();
            const last = String(u.lastName ?? "").trim();
            const full = [first, last].filter(Boolean).join(" ");
            return full || String(u.email ?? "").trim();
          },
          linkTo: { table: "employees", filterField: "userId" },
        },
      },
      { key: "shiftId", label: "Shift", type: "fk", fkTable: "shifts", fkLabel: "title", required: true },
      { key: "employeeId", label: "Employee", type: "fk", fkTable: "users", fkLabel: "email", required: true },
      {
        key: "status", label: "Status", type: "select", required: true,
        options: [
          { label: "Pending", value: "pending" },
          { label: "Accepted", value: "accepted" },
          { label: "Declined", value: "declined" },
        ],
      },
      { key: "createdAt", label: "Created", type: "datetime", readonly: true },
    ],
  },
  {
    name: "time_entries",
    label: "Time Entries",
    plural: "time entries",
    importSupported: true,
    primaryLabelField: "id",
    fields: [
      { key: "id", label: "ID", type: "text", readonly: true, hiddenInGrid: true },
      {
        key: "__name", label: "Name", type: "text", readonly: true,
        derived: {
          fromField: "employeeId",
          render: (u) => {
            if (!u) return "";
            const first = String(u.firstName ?? "").trim();
            const last = String(u.lastName ?? "").trim();
            const full = [first, last].filter(Boolean).join(" ");
            return full || String(u.email ?? "").trim();
          },
          linkTo: { table: "employees", filterField: "userId" },
        },
      },
      {
        key: "__timeCard", label: "Time Card", type: "text", readonly: true,
        derived: {
          fromField: "employeeId",
          render: (u) => (u ? "View time card" : ""),
          linkRoute: (employeeId) => `/payroll/time-card?employeeId=${encodeURIComponent(employeeId)}`,
        },
      },
      // shiftId is nullable in the DB (geo clock-in entries have no scheduled shift). Optional on import.
      { key: "shiftId", label: "Shift", type: "fk", fkTable: "shifts", fkLabel: "title", importResolveByLabel: true, importExample: "Leave blank if importing ad-hoc hours" },
      // siteId — handy when the spreadsheet has a "Location"/"Site" column instead of a shift.
      { key: "siteId", label: "Site", type: "fk", fkTable: "sites", fkLabel: "name", importResolveByLabel: true, importExample: "Acme HQ" },
      // Employee matches by full name (e.g. "John Smith"). Email also accepted as a fallback (resolved server-side).
      {
        key: "employeeId", label: "Employee", type: "fk", fkTable: "users", fkLabel: "email", required: true,
        importResolveByLabel: true,
        importMatchLabel: "name",
        importMatchKeyFn: (u) => `${u?.firstName ?? ""} ${u?.lastName ?? ""}`.trim().replace(/\s+/g, " ").toLowerCase(),
        importExample: "John Smith",
      },
      { key: "clockInTime", label: "Clock In", type: "datetime", required: true, importExample: "2025-01-06 08:00" },
      { key: "clockOutTime", label: "Clock Out", type: "datetime", importExample: "2025-01-06 16:00" },
      { key: "hoursWorked", label: "Hours", type: "number", importExample: "8.00" },
      {
        key: "approvalStatus", label: "Approval", type: "select",
        options: [
          { label: "Pending", value: "pending" },
          { label: "Approved", value: "approved" },
          { label: "Rejected", value: "rejected" },
        ],
      },
      { key: "notes", label: "Notes", type: "textarea", hiddenInGrid: true },
      { key: "correctionRequested", label: "Correction Requested", type: "boolean" },
      { key: "correctionNote", label: "Correction Note", type: "textarea", hiddenInGrid: true },
    ],
  },
  {
    name: "payroll_entries",
    label: "Payroll",
    plural: "payroll entries",
    importSupported: true,
    primaryLabelField: "id",
    fields: [
      { key: "id", label: "ID", type: "text", readonly: true, hiddenInGrid: true },
      { key: "employeeId", label: "Employee", type: "fk", fkTable: "users", fkLabel: "email", required: true },
      { key: "siteId", label: "Site", type: "fk", fkTable: "sites", fkLabel: "name" },
      { key: "periodStart", label: "Period Start", type: "date", required: true },
      { key: "periodEnd", label: "Period End", type: "date", required: true },
      { key: "totalHours", label: "Hours", type: "number" },
      { key: "hourlyRate", label: "Rate ($)", type: "number" },
      { key: "grossPay", label: "Gross ($)", type: "number" },
      { key: "netPay", label: "Net ($)", type: "number" },
      {
        key: "status", label: "Status", type: "select",
        options: [
          { label: "Pending", value: "pending" },
          { label: "Processed", value: "processed" },
          { label: "Paid", value: "paid" },
        ],
      },
      { key: "paidAt", label: "Paid At", type: "datetime" },
    ],
  },
  {
    name: "invoices",
    label: "Invoices",
    plural: "invoices",
    importSupported: true,
    primaryLabelField: "invoiceNumber",
    fields: [
      { key: "id", label: "ID", type: "text", readonly: true, hiddenInGrid: true },
      { key: "invoiceNumber", label: "Invoice #", type: "text", required: true },
      { key: "clientId", label: "Client", type: "fk", fkTable: "clients", fkLabel: "name" },
      { key: "siteId", label: "Site", type: "fk", fkTable: "sites", fkLabel: "name" },
      { key: "clientName", label: "Client Name", type: "text", required: true },
      { key: "clientEmail", label: "Client Email", type: "email" },
      { key: "periodStart", label: "Period Start", type: "date" },
      { key: "periodEnd", label: "Period End", type: "date" },
      { key: "subtotal", label: "Subtotal ($)", type: "number" },
      { key: "taxAmount", label: "Tax ($)", type: "number" },
      { key: "totalAmount", label: "Total ($)", type: "number" },
      {
        key: "status", label: "Status", type: "select",
        options: [
          { label: "Draft", value: "draft" },
          { label: "Sent", value: "sent" },
          { label: "Paid", value: "paid" },
          { label: "Overdue", value: "overdue" },
        ],
      },
      { key: "dueDate", label: "Due Date", type: "date", required: true },
      { key: "paidAt", label: "Paid At", type: "datetime" },
    ],
  },
  {
    name: "incidents",
    label: "Incidents",
    plural: "incidents",
    importSupported: true,
    primaryLabelField: "title",
    fields: [
      { key: "id", label: "ID", type: "text", readonly: true, hiddenInGrid: true },
      { key: "employeeId", label: "Employee", type: "fk", fkTable: "users", fkLabel: "email", required: true },
      { key: "shiftId", label: "Shift", type: "fk", fkTable: "shifts", fkLabel: "title" },
      { key: "title", label: "Title", type: "text", required: true },
      { key: "description", label: "Description", type: "textarea", required: true },
      {
        key: "severity", label: "Severity", type: "select", required: true,
        options: [
          { label: "Low", value: "low" },
          { label: "Medium", value: "medium" },
          { label: "High", value: "high" },
          { label: "Critical", value: "critical" },
        ],
      },
      {
        key: "status", label: "Status", type: "select", required: true,
        options: [
          { label: "Open", value: "open" },
          { label: "Investigating", value: "investigating" },
          { label: "Resolved", value: "resolved" },
          { label: "Closed", value: "closed" },
        ],
      },
      { key: "occurredAt", label: "Occurred At", type: "datetime", required: true },
      { key: "resolvedAt", label: "Resolved At", type: "datetime" },
      { key: "locationDescription", label: "Location", type: "text", hiddenInGrid: true },
      { key: "adminNotes", label: "Admin Notes", type: "textarea", hiddenInGrid: true },
    ],
  },
  {
    name: "licenses",
    label: "Licences",
    plural: "licences",
    importSupported: true,
    primaryLabelField: "licenseNumber",
    fields: [
      { key: "id", label: "ID", type: "text", readonly: true, hiddenInGrid: true },
      { key: "employeeId", label: "Employee", type: "fk", fkTable: "users", fkLabel: "email", required: true },
      { key: "type", label: "Type", type: "text", required: true },
      {
        key: "level", label: "Level", type: "select",
        options: [
          { label: "Level 1 (Support Staff)", value: "1" },
          { label: "Level 2 (unarmed)", value: "2" },
          { label: "Level 3 (armed)", value: "3" },
          { label: "Level 4 (PPO)", value: "4" },
        ],
      },
      { key: "licenseNumber", label: "Licence #", type: "text", required: true },
      { key: "issuingAuthority", label: "Authority", type: "text" },
      { key: "issueDate", label: "Issued", type: "date" },
      { key: "expiryDate", label: "Expires", type: "date", required: true },
      { key: "notes", label: "Notes", type: "textarea", hiddenInGrid: true },
    ],
  },
  {
    name: "training-certifications",
    label: "Training",
    plural: "training certificates",
    importSupported: false,
    primaryLabelField: "title",
    fields: [
      { key: "id", label: "ID", type: "text", readonly: true, hiddenInGrid: true },
      { key: "employeeId", label: "Employee", type: "fk", fkTable: "users", fkLabel: "email", required: true },
      { key: "type", label: "Type (slug)", type: "text", required: true },
      { key: "title", label: "Title", type: "text", required: true },
      { key: "issuingAuthority", label: "Authority", type: "text" },
      { key: "certificateNumber", label: "Cert #", type: "text" },
      { key: "issueDate", label: "Issued", type: "date" },
      { key: "expiryDate", label: "Expires", type: "date" },
      { key: "notes", label: "Notes", type: "textarea", hiddenInGrid: true },
    ],
  },
  {
    name: "subcontractors",
    label: "Subcontractors",
    plural: "subcontractors",
    importSupported: true,
    primaryLabelField: "companyName",
    fields: [
      { key: "id", label: "ID", type: "text", readonly: true, hiddenInGrid: true, section: "Identity" },
      { key: "companyName", label: "Company", type: "text", required: true, section: "Identity", importExample: "Lone Star Patrol LLC" },
      {
        key: "status", label: "Status", type: "select", section: "Identity",
        options: [
          { label: "Active", value: "active" },
          { label: "Inactive", value: "inactive" },
        ],
        importExample: "active",
      },
      { key: "contactName", label: "Contact", type: "text", section: "Contact", importExample: "Jane Doe" },
      { key: "contactEmail", label: "Email", type: "email", section: "Contact", importExample: "ap@lonestar.com" },
      { key: "contactPhone", label: "Phone", type: "text", section: "Contact", importExample: "+1 512 555 0142" },
      { key: "address", label: "Address", type: "textarea", hiddenInGrid: true, section: "Contact", importExample: "123 Main St, Austin, TX 78701" },
      { key: "taxId", label: "Tax ID (EIN)", type: "text", hiddenInGrid: true, section: "Tax & Terms", importExample: "12-3456789" },
      { key: "paymentTermsDays", label: "Payment Terms (days)", type: "integer", section: "Tax & Terms", importExample: "30" },
      { key: "w9DocKey", label: "W-9 Document", type: "fileKey", hiddenInGrid: true, section: "Tax & Terms" },
      { key: "bankAccountName", label: "Bank Account Name", type: "text", hiddenInGrid: true, section: "Banking (for ACH payment)" },
      { key: "bankAccountType", label: "Account Type", type: "select", options: [{ label: "Checking", value: "Checking" }, { label: "Savings", value: "Savings" }], hiddenInGrid: true, section: "Banking (for ACH payment)" },
      { key: "bankRoutingNumber", label: "Routing Number", type: "text", hiddenInGrid: true, section: "Banking (for ACH payment)" },
      { key: "bankAccountNumber", label: "Account Number", type: "text", hiddenInGrid: true, section: "Banking (for ACH payment)" },
      { key: "directDepositConsent", label: "Direct Deposit Consent", type: "boolean", hiddenInGrid: true, section: "Banking (for ACH payment)" },
      { key: "stripeAccountId", label: "Stripe Account ID", type: "text", hiddenInGrid: true, section: "Banking (for ACH payment)" },
      { key: "notes", label: "Notes", type: "textarea", hiddenInGrid: true, section: "Notes" },
      { key: "createdAt", label: "Created", type: "datetime", readonly: true, hiddenInGrid: true },
    ],
  },
  {
    name: "subcontractor_cois",
    label: "Certificates of Insurance",
    plural: "certificates of insurance",
    importSupported: false,
    primaryLabelField: "policyNumber",
    fields: [
      { key: "id", label: "ID", type: "text", readonly: true, hiddenInGrid: true, section: "Identity" },
      { key: "subcontractorId", label: "Subcontractor", type: "fk", fkTable: "subcontractors", fkLabel: "companyName", required: true, section: "Identity" },
      {
        key: "coverageType", label: "Coverage Type", type: "select", required: true, section: "Coverage",
        options: [
          { label: "General Liability", value: "general_liability" },
          { label: "Workers' Comp", value: "workers_comp" },
          { label: "Auto", value: "auto" },
          { label: "Umbrella", value: "umbrella" },
          { label: "Professional", value: "professional" },
          { label: "Other", value: "other" },
        ],
      },
      { key: "insurer", label: "Insurer", type: "text", section: "Coverage" },
      { key: "policyNumber", label: "Policy #", type: "text", section: "Coverage" },
      { key: "coverageAmount", label: "Coverage Amount ($)", type: "number", section: "Coverage" },
      { key: "effectiveDate", label: "Effective", type: "date", section: "Dates" },
      { key: "expiryDate", label: "Expires", type: "date", required: true, section: "Dates" },
      { key: "documentKey", label: "COI Document", type: "fileKey", hiddenInGrid: true, section: "Document" },
      { key: "notes", label: "Notes", type: "textarea", hiddenInGrid: true, section: "Notes" },
    ],
  },
  {
    name: "subcontractor_contracts",
    label: "Subcontractor Contracts",
    plural: "subcontractor contracts",
    importSupported: false,
    primaryLabelField: "title",
    fields: [
      { key: "id", label: "ID", type: "text", readonly: true, hiddenInGrid: true, section: "Identity" },
      { key: "subcontractorId", label: "Subcontractor", type: "fk", fkTable: "subcontractors", fkLabel: "companyName", required: true, section: "Identity" },
      { key: "title", label: "Title", type: "text", required: true, section: "Details" },
      { key: "contractType", label: "Type", type: "text", section: "Details" },
      {
        key: "status", label: "Status", type: "select", section: "Details",
        options: [
          { label: "Draft", value: "draft" },
          { label: "Active", value: "active" },
          { label: "Expired", value: "expired" },
          { label: "Terminated", value: "terminated" },
        ],
      },
      { key: "value", label: "Value ($)", type: "number", section: "Details" },
      { key: "startDate", label: "Start", type: "date", section: "Dates" },
      { key: "endDate", label: "End", type: "date", section: "Dates" },
      { key: "documentKey", label: "Contract Document", type: "fileKey", hiddenInGrid: true, section: "Document" },
      { key: "notes", label: "Notes", type: "textarea", hiddenInGrid: true, section: "Notes" },
    ],
  },
  {
    name: "subcontractor_invoices",
    label: "Subcontractor Invoices",
    plural: "subcontractor invoices",
    importSupported: false,
    primaryLabelField: "invoiceNumber",
    fields: [
      { key: "id", label: "ID", type: "text", readonly: true, hiddenInGrid: true, section: "Identity" },
      { key: "subcontractorId", label: "Subcontractor", type: "fk", fkTable: "subcontractors", fkLabel: "companyName", required: true, section: "Identity" },
      { key: "invoiceNumber", label: "Invoice #", type: "text", required: true, section: "Identity" },
      { key: "description", label: "Description", type: "textarea", hiddenInGrid: true, section: "Details" },
      {
        key: "status", label: "Status", type: "select", section: "Details",
        options: [
          { label: "Pending", value: "pending" },
          { label: "Approved", value: "approved" },
          { label: "Rejected", value: "rejected" },
          { label: "Processed", value: "processed" },
          { label: "Paid", value: "paid" },
          { label: "Failed", value: "failed" },
        ],
      },
      { key: "subtotal", label: "Subtotal ($)", type: "number", section: "Amounts" },
      { key: "taxAmount", label: "Tax ($)", type: "number", section: "Amounts" },
      { key: "totalAmount", label: "Total ($)", type: "number", section: "Amounts" },
      { key: "issueDate", label: "Issued", type: "date", section: "Dates" },
      { key: "dueDate", label: "Due", type: "date", section: "Dates" },
      { key: "documentKey", label: "Invoice Document", type: "fileKey", hiddenInGrid: true, section: "Document" },
      { key: "paidMethod", label: "Paid Method", type: "text", readonly: true, hiddenInGrid: true, section: "Payment (read-only)" },
      { key: "paymentReference", label: "Payment Ref", type: "text", readonly: true, hiddenInGrid: true, section: "Payment (read-only)" },
      { key: "paidAt", label: "Paid At", type: "datetime", readonly: true, hiddenInGrid: true, section: "Payment (read-only)" },
      { key: "notes", label: "Notes", type: "textarea", hiddenInGrid: true, section: "Notes" },
      { key: "createdAt", label: "Created", type: "datetime", readonly: true, hiddenInGrid: true },
    ],
  },
];

export function getTable(name: string): TableDescriptor | undefined {
  return TABLES.find((t) => t.name === name);
}
