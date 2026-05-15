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
  | "json";

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
  fields: Field[];
};

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
      { key: "id", label: "ID", type: "text", readonly: true, hiddenInGrid: true },
      { key: "userId", label: "User", type: "fk", fkTable: "users", fkLabel: "email", required: true },
      { key: "phone", label: "Phone", type: "text" },
      { key: "address", label: "Address", type: "textarea" },
      { key: "emergencyContactName", label: "Emergency Contact", type: "text" },
      { key: "emergencyContactPhone", label: "Emergency Phone", type: "text" },
      { key: "hourlyRate", label: "Hourly Rate (£)", type: "number" },
      { key: "bankAccountName", label: "Bank Acct Name", type: "text", hiddenInGrid: true },
      { key: "bankAccountNumber", label: "Bank Acct #", type: "text", hiddenInGrid: true },
      { key: "bankBsb", label: "Sort Code/BSB", type: "text", hiddenInGrid: true },
      { key: "createdAt", label: "Created", type: "datetime", readonly: true },
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
    importSupported: false,
    primaryLabelField: "title",
    fields: [
      { key: "id", label: "ID", type: "text", readonly: true, hiddenInGrid: true },
      { key: "title", label: "Title", type: "text", required: true },
      { key: "siteId", label: "Site", type: "fk", fkTable: "sites", fkLabel: "name" },
      { key: "startTime", label: "Start", type: "datetime", required: true },
      { key: "endTime", label: "End", type: "datetime", required: true },
      { key: "payRate", label: "Pay Rate (£)", type: "number", required: true },
      { key: "billRate", label: "Bill Rate (£)", type: "number", required: true },
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
    importSupported: false,
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
    importSupported: false,
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
    importSupported: false,
    primaryLabelField: "id",
    fields: [
      { key: "id", label: "ID", type: "text", readonly: true, hiddenInGrid: true },
      { key: "employeeId", label: "Employee", type: "fk", fkTable: "users", fkLabel: "email", required: true },
      { key: "siteId", label: "Site", type: "fk", fkTable: "sites", fkLabel: "name" },
      { key: "periodStart", label: "Period Start", type: "date", required: true },
      { key: "periodEnd", label: "Period End", type: "date", required: true },
      { key: "totalHours", label: "Hours", type: "number" },
      { key: "hourlyRate", label: "Rate (£)", type: "number" },
      { key: "grossPay", label: "Gross (£)", type: "number" },
      { key: "tax", label: "Tax (£)", type: "number" },
      { key: "netPay", label: "Net (£)", type: "number" },
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
    importSupported: false,
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
      { key: "subtotal", label: "Subtotal (£)", type: "number" },
      { key: "taxAmount", label: "Tax (£)", type: "number" },
      { key: "totalAmount", label: "Total (£)", type: "number" },
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
    importSupported: false,
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
    importSupported: false,
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
