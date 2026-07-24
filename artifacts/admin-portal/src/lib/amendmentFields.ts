export type AmendmentFieldType = "text" | "textarea" | "number" | "date" | "file";

export interface AmendmentFieldDef {
  key: string;
  label: string;
  type: AmendmentFieldType;
  accept?: string;
  dbKey?: string;
}

export const AMENDMENT_FIELDS: AmendmentFieldDef[] = [
  { key: "phone", label: "Phone number", type: "text" },
  { key: "address", label: "Home address", type: "textarea" },
  { key: "dateOfBirth", label: "Date of birth", type: "date" },
  { key: "cityOfBirth", label: "City of birth", type: "text" },
  { key: "stateOfBirth", label: "State of birth", type: "text" },
  { key: "niNumber", label: "SSN (last 4 digits)", type: "text" },
  { key: "rightToWorkStatus", label: "Right-to-work status", type: "text" },
  { key: "rightToWorkDoc", label: "Right-to-work document", type: "file", accept: "image/*,.pdf", dbKey: "rightToWorkDocKey" },
  { key: "siaLicenseNumber", label: "TX security license number", type: "text" },
  { key: "siaLicenseLevel", label: "License level (1=Support Staff, 2, 3, or 4)", type: "number" },
  { key: "siaLicenseExpiry", label: "License expiry date", type: "date" },
  { key: "previousExperience", label: "Previous security experience", type: "textarea" },
  { key: "yearsExperience", label: "Years of experience", type: "number" },
  { key: "photo", label: "Profile photo", type: "file", accept: "image/*", dbKey: "photoKey" },
  { key: "cv", label: "Resume", type: "file", accept: ".pdf,.doc,.docx", dbKey: "cvKey" },
];

export const AMENDMENT_FIELD_MAP: Record<string, AmendmentFieldDef> =
  Object.fromEntries(AMENDMENT_FIELDS.map((f) => [f.key, f]));
