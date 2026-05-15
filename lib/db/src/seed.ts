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
