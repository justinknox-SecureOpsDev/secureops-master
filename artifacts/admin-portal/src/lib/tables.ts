/**
 * Table descriptors drive the entire generic admin UI: sidebar list, grid
 * columns, edit form, FK dropdowns, Excel import column mapping, and template
 * .xlsx download. Keep this aligned with `lib/db/src/schema/*` and the server's
 * `/admin/tables/:table` endpoint registry in `artifacts/api-server/src/routes/admin.ts`.
 */

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
  /** Optional section header label rendered above this field in the row dialog.
   *  Lets long forms (e.g. employees) be visually grouped (Identity / Licence / Pay …). */
  section?: string;
  /** Sample value written into the second row of the downloadable XLSX
   *  template so admins can see the expected format. Falls back to a
   *  generic per-type sample when omitted. Ignored entirely for field
   *  types that aren't supported by Excel import (e.g. file uploads). */
  importExample?: string;
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
  /** Field that best identifies a row (used for FK dropdown labels). */
  primaryLabelField: string;
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
    name: "users",
    label: "Users",
    plural: "users",
    importSupported: true,
    primaryLabelField: "email",
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
      { key: "userId", label: "User", type: "fk", fkTable: "users", fkLabel: "email", required: true, section: "Identity", importResolveByLabel: true, importExample: "name@example.com" },
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
      { key: "cvKey", label: "Résumé / CV", type: "fileKey", hiddenInGrid: true },
      { key: "trainingCertificateKeys", label: "Training Certificates", type: "fileKeyList", hiddenInGrid: true },
      { key: "availability", label: "Weekly Availability", type: "json", hiddenInGrid: true, importExample: '{"mon":["am","pm"],"tue":["pm"],"wed":[],"thu":["am","pm","night"],"fri":["night"],"sat":["pm","night"],"sun":[]}' },
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
      { key: "notes", label: "Notes", type: "textarea", hiddenInGrid: true },
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
      { key: "address", label: "Address", type: "textarea" },
      { key: "locationLat", label: "Lat", type: "number", hiddenInGrid: true },
      { key: "locationLng", label: "Lng", type: "number", hiddenInGrid: true },
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
      { key: "shiftId", label: "Shift", type: "fk", fkTable: "shifts", fkLabel: "title", required: true },
      { key: "employeeId", label: "Employee", type: "fk", fkTable: "users", fkLabel: "email", required: true },
      { key: "clockInTime", label: "Clock In", type: "datetime", required: true },
      { key: "clockOutTime", label: "Clock Out", type: "datetime" },
      { key: "hoursWorked", label: "Hours", type: "number" },
      {
        key: "approvalStatus", label: "Approval", type: "select",
        options: [
          { label: "Pending", value: "pending" },
          { label: "Approved", value: "approved" },
          { label: "Rejected", value: "rejected" },
        ],
      },
      { key: "notes", label: "Notes", type: "textarea", hiddenInGrid: true },
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
      { key: "tax", label: "Tax ($)", type: "number" },
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
];

export function getTable(name: string): TableDescriptor | undefined {
  return TABLES.find((t) => t.name === name);
}
