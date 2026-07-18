import type { ApplicationFieldConfig } from "@workspace/db";

/**
 * Registry of the *built-in* (hardcoded) public application fields.
 *
 * These are the fields the Apply wizard has always rendered. Admins can now
 * tweak them through the form builder — rename, mark optional, hide, reorder
 * within a section — and those tweaks are persisted as override rows in
 * `application_field_config`. This registry holds the immutable *defaults* and
 * the locked-ness of each field; it is the single source of truth both the
 * template endpoint and the submit validator merge config against.
 *
 * The five locked core fields (firstName, lastName, email, phone, address)
 * may only be relabelled — they are always required and always visible.
 */

/** Wizard step / section a field belongs to. Mirrors Apply.tsx BASE_STEPS. */
export const APPLICATION_FIELD_SECTIONS = [
  "Personal",
  "I-9 & Identity",
  "TX License & experience",
  "References & docs",
  "Availability",
] as const;

export type ApplicationFieldSection = number; // 0..4 index into the array above

export interface ApplicationFieldDef {
  key: string;
  section: ApplicationFieldSection;
  defaultLabel: string;
  defaultHelp: string | null;
  defaultRequired: boolean;
  /** Locked = always required + always visible; only the label may be overridden. */
  locked: boolean;
}

/**
 * Order within this array == default sort order within a section. The merge
 * helper derives each field's default sortOrder from its index among the
 * fields that share its section.
 */
export const APPLICATION_FIELD_REGISTRY: ApplicationFieldDef[] = [
  // ---- Section 0: Personal ----
  { key: "firstName", section: 0, defaultLabel: "First name", defaultHelp: null, defaultRequired: true, locked: true },
  { key: "lastName", section: 0, defaultLabel: "Last name", defaultHelp: null, defaultRequired: true, locked: true },
  { key: "email", section: 0, defaultLabel: "Email", defaultHelp: null, defaultRequired: true, locked: true },
  { key: "phone", section: 0, defaultLabel: "Phone", defaultHelp: null, defaultRequired: true, locked: true },
  { key: "address", section: 0, defaultLabel: "Street address", defaultHelp: null, defaultRequired: true, locked: true },
  { key: "city", section: 0, defaultLabel: "City", defaultHelp: null, defaultRequired: true, locked: false },
  { key: "state", section: 0, defaultLabel: "State", defaultHelp: null, defaultRequired: true, locked: false },
  { key: "zip", section: 0, defaultLabel: "ZIP code", defaultHelp: null, defaultRequired: true, locked: false },
  { key: "dateOfBirth", section: 0, defaultLabel: "Date of birth", defaultHelp: null, defaultRequired: true, locked: false },
  { key: "niNumber", section: 0, defaultLabel: "SSN (last 4)", defaultHelp: null, defaultRequired: true, locked: false },
  { key: "cityOfBirth", section: 0, defaultLabel: "City of birth", defaultHelp: null, defaultRequired: true, locked: false },
  { key: "stateOfBirth", section: 0, defaultLabel: "State / county of birth", defaultHelp: null, defaultRequired: true, locked: false },
  // ---- Section 1: I-9 & Identity ----
  // "i9" (fillable in-app Form I-9 Section 1) replaced the old "i9Doc" upload
  // field. Deliberately a NEW key: stale application_field_config rows for
  // i9Doc (old label/required/hidden overrides) are silently ignored by the
  // merge, so the fillable form always starts from clean defaults.
  { key: "i9", section: 1, defaultLabel: "Form I-9 — Employment Eligibility (Section 1)", defaultHelp: null, defaultRequired: true, locked: false },
  { key: "ssnCardDoc", section: 1, defaultLabel: "Social Security card (photo of front)", defaultHelp: null, defaultRequired: true, locked: false },
  { key: "idDocType", section: 1, defaultLabel: "Photo ID type", defaultHelp: null, defaultRequired: true, locked: false },
  { key: "idDoc", section: 1, defaultLabel: "Photo ID", defaultHelp: null, defaultRequired: true, locked: false },
  // ---- Section 2: TX License & experience ----
  { key: "siaLicenseNumber", section: 2, defaultLabel: "TX security license number", defaultHelp: null, defaultRequired: true, locked: false },
  { key: "siaLicenseLevel", section: 2, defaultLabel: "License level", defaultHelp: null, defaultRequired: true, locked: false },
  { key: "siaLicenseExpiry", section: 2, defaultLabel: "License expiry", defaultHelp: null, defaultRequired: true, locked: false },
  { key: "yearsExperience", section: 2, defaultLabel: "Years of experience", defaultHelp: null, defaultRequired: true, locked: false },
  { key: "previousExperience", section: 2, defaultLabel: "Describe your previous security experience", defaultHelp: null, defaultRequired: true, locked: false },
  // ---- Section 3: References & docs ----
  { key: "references", section: 3, defaultLabel: "References", defaultHelp: null, defaultRequired: true, locked: false },
  { key: "photo", section: 3, defaultLabel: "Head & shoulders photo", defaultHelp: null, defaultRequired: true, locked: false },
  { key: "cv", section: 3, defaultLabel: "Resume (PDF / DOC)", defaultHelp: null, defaultRequired: true, locked: false },
  { key: "trainingCertificates", section: 3, defaultLabel: "Training certificates", defaultHelp: null, defaultRequired: true, locked: false },
  // ---- Section 4: Availability ----
  { key: "availability", section: 4, defaultLabel: "Availability", defaultHelp: null, defaultRequired: true, locked: false },
];

const REGISTRY_BY_KEY = new Map(APPLICATION_FIELD_REGISTRY.map((f) => [f.key, f]));

/** Default sort order of a field = its index among fields sharing its section. */
const DEFAULT_SORT_BY_KEY = (() => {
  const counters = new Map<number, number>();
  const out = new Map<string, number>();
  for (const f of APPLICATION_FIELD_REGISTRY) {
    const n = counters.get(f.section) ?? 0;
    out.set(f.key, n);
    counters.set(f.section, n + 1);
  }
  return out;
})();

export function isBuiltInApplicationField(key: string): boolean {
  return REGISTRY_BY_KEY.has(key);
}

export interface EffectiveApplicationField {
  key: string;
  section: ApplicationFieldSection;
  label: string;
  helpText: string | null;
  required: boolean;
  hidden: boolean;
  sortOrder: number;
  locked: boolean;
}

/**
 * Merge the static registry with persisted override rows into the effective
 * field config the rest of the system consumes.
 *
 * Override semantics:
 *   - label:    labelOverride ?? defaultLabel
 *   - helpText: null override row value = no override (use default);
 *               "" = explicitly cleared (no help shown); any text = that text
 *   - required: locked ? true : (requiredOverride ?? defaultRequired)
 *   - hidden:   locked ? false : (row.hidden ?? false)
 *   - sortOrder: row.sortOrder ?? default-by-section-index
 */
export function mergeApplicationFields(
  rows: ApplicationFieldConfig[],
): EffectiveApplicationField[] {
  const byKey = new Map(rows.map((r) => [r.fieldKey, r]));
  const merged = APPLICATION_FIELD_REGISTRY.map((def): EffectiveApplicationField => {
    const row = byKey.get(def.key);
    const label = row?.labelOverride?.trim() ? row.labelOverride.trim() : def.defaultLabel;
    let helpText: string | null = def.defaultHelp;
    if (row && row.helpTextOverride !== null && row.helpTextOverride !== undefined) {
      const trimmed = row.helpTextOverride.trim();
      helpText = trimmed.length > 0 ? trimmed : null;
    }
    const required = def.locked ? true : (row?.requiredOverride ?? def.defaultRequired);
    const hidden = def.locked ? false : (row?.hidden ?? false);
    const sortOrder = row?.sortOrder ?? DEFAULT_SORT_BY_KEY.get(def.key) ?? 0;
    return {
      key: def.key,
      section: def.section,
      label,
      helpText,
      required,
      hidden,
      sortOrder,
      locked: def.locked,
    };
  });
  merged.sort((a, b) => (a.section - b.section) || (a.sortOrder - b.sortOrder));
  return merged;
}
