import { sql } from "drizzle-orm";
import { db } from "./index";
import { policiesTable } from "./schema/policies";

/**
 * Default acknowledgement policies seeded on first boot if the policies
 * table is empty. Slugs are stable identifiers — labels can be edited
 * later via the admin Policies page.
 */
export const DEFAULT_POLICY_SLUGS: { slug: string; label: string }[] = [
  { slug: "drug_free", label: "Drug-Free Workplace Policy" },
  { slug: "uniform", label: "Uniform Standard of Use" },
  { slug: "nda", label: "Non-Disclosure Agreement" },
  { slug: "contract", label: "Employment Contract" },
];

/**
 * Seed default policies if the policies table is empty. Idempotent —
 * safe to call on every server start. Called from the API server boot
 * sequence and lazily from the policies routes.
 */
export async function seedPolicies(): Promise<void> {
  const existing = await db.select({ id: policiesTable.id }).from(policiesTable).limit(1);
  if (existing.length > 0) return;
  await db.insert(policiesTable).values(
    DEFAULT_POLICY_SLUGS.map((p) => ({
      slug: p.slug,
      label: p.label,
      version: 1,
      isActive: true,
    })),
  );
}

/**
 * One-time backfill: copy applicant + onboarding-submission fields onto the
 * employees row that was created when the application was approved.
 *
 * Idempotent — uses COALESCE so existing employee values are never overwritten;
 * we only fill columns that are NULL today. Safe to run on every boot.
 */
export async function backfillEmployeeProfileFields(): Promise<void> {
  // Applications -> employees (matched via applications.created_employee_id = employees.user_id)
  await db.execute(sql`
    UPDATE employees e SET
      phone                       = COALESCE(e.phone, a.phone),
      address                     = COALESCE(e.address, a.address),
      date_of_birth               = COALESCE(e.date_of_birth, a.date_of_birth),
      city_of_birth               = COALESCE(e.city_of_birth, a.city_of_birth),
      state_of_birth              = COALESCE(e.state_of_birth, a.state_of_birth),
      ni_number                   = COALESCE(e.ni_number, a.ni_number),
      right_to_work_status        = COALESCE(e.right_to_work_status, a.right_to_work_status),
      right_to_work_doc_key       = COALESCE(e.right_to_work_doc_key, a.right_to_work_doc_key),
      sia_license_number          = COALESCE(e.sia_license_number, a.sia_license_number),
      sia_license_level           = COALESCE(e.sia_license_level, a.sia_license_level),
      sia_license_expiry          = COALESCE(e.sia_license_expiry, a.sia_license_expiry),
      previous_experience         = COALESCE(e.previous_experience, a.previous_experience),
      years_experience            = COALESCE(e.years_experience, a.years_experience),
      "references"                = COALESCE(e."references", a."references"),
      photo_key                   = COALESCE(e.photo_key, a.photo_key),
      cv_key                      = COALESCE(e.cv_key, a.cv_key),
      training_certificate_keys   = COALESCE(e.training_certificate_keys, a.training_certificate_keys),
      availability                = COALESCE(e.availability, a.availability),
      application_id              = COALESCE(e.application_id, a.id)
    FROM applications a
    WHERE a.created_employee_id = e.user_id;
  `);

  // Onboarding submissions -> employees (matched via onboarding_submissions.employee_id = employees.user_id)
  await db.execute(sql`
    UPDATE employees e SET
      bank_account_name              = COALESCE(e.bank_account_name, o.bank_account_name),
      bank_account_number            = COALESCE(e.bank_account_number, o.bank_account_number),
      bank_bsb                       = COALESCE(e.bank_bsb, o.bank_sort_code),
      ni_number                      = COALESCE(e.ni_number, o.ni_number_confirmed),
      tax_code                       = COALESCE(e.tax_code, o.tax_code),
      pay_stub_doc_key               = COALESCE(e.pay_stub_doc_key, o.p45_doc_key),
      emergency_contact_name         = COALESCE(e.emergency_contact_name, o.emergency_contact_name),
      emergency_contact_relationship = COALESCE(e.emergency_contact_relationship, o.emergency_contact_relationship),
      emergency_contact_phone        = COALESCE(e.emergency_contact_phone, o.emergency_contact_phone),
      uniform_shirt                  = COALESCE(e.uniform_shirt, o.uniform_shirt),
      uniform_trousers               = COALESCE(e.uniform_trousers, o.uniform_trousers),
      uniform_jacket                 = COALESCE(e.uniform_jacket, o.uniform_jacket),
      uniform_boots                  = COALESCE(e.uniform_boots, o.uniform_boots),
      license_doc_key                = COALESCE(e.license_doc_key, o.sia_license_doc_key),
      passport_doc_key               = COALESCE(e.passport_doc_key, o.passport_doc_key),
      direct_deposit_consent         = COALESCE(e.direct_deposit_consent, o.direct_deposit_consent),
      direct_deposit_signature       = COALESCE(e.direct_deposit_signature, o.direct_deposit_signature),
      acknowledgements               = COALESCE(e.acknowledgements, o.acknowledgements),
      onboarding_submission_id       = COALESCE(e.onboarding_submission_id, o.id)
    FROM onboarding_submissions o
    WHERE o.employee_id = e.user_id;
  `);
}

/**
 * One-time idempotent backfill: flag existing NON-ADMIN staff (officers /
 * site managers) who have never signed company policies so the mobile login
 * gate (users.must_sign_policies) catches them once. "Has signed" = a
 * non-empty acknowledgements array on their employee file (onboarding copies
 * acks there; the in-app POST /me/policies/acknowledge also writes there).
 *
 * Scope is employee + site_manager only — admins are never gated, and external
 * clients use the web portal (which ignores this flag), so neither is touched.
 * Only flips false -> true, so it's safe on every boot: once an officer signs
 * (acks recorded, flag cleared) they are never re-flagged. Also no-ops when
 * there are zero active policies — nothing to sign means nobody is gated, which
 * avoids a re-flag loop with the zero-policy "Continue" path on the sign screen.
 */
export async function backfillMustSignPolicies(): Promise<void> {
  await db.execute(sql`
    UPDATE users u SET must_sign_policies = true
    WHERE u.role IN ('employee', 'site_manager')
      AND u.must_sign_policies = false
      AND EXISTS (SELECT 1 FROM policies p WHERE p.is_active = true)
      AND NOT EXISTS (
        SELECT 1 FROM employees e
        WHERE e.user_id = u.id
          AND e.acknowledgements IS NOT NULL
          AND jsonb_typeof(e.acknowledgements) = 'array'
          AND e.acknowledgements != '[]'::jsonb
      );
  `);
}
