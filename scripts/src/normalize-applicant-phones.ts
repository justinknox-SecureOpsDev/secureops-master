/**
 * One-off backfill: normalize every stored phone number to E.164.
 *
 * Task #104 originally normalized only `applications.phone`. Task #123
 * extends the same normalization pass to every other free-text phone
 * column in the system so SMS-style features (emergency alerts, future
 * reference-check texts, admin direct-message-officer, etc.) actually
 * dispatch instead of silently skipping pre-existing rows.
 *
 * Covered:
 *   - applications.phone
 *   - applications.references[].phone (JSON array)
 *   - employees.phone
 *   - employees.emergency_contact_phone
 *   - onboarding_submissions.emergency_contact_phone
 *   - users.phone_number
 *
 * Run with:
 *   pnpm --filter @workspace/scripts exec tsx ./src/normalize-applicant-phones.ts
 *
 * Idempotent: rows already in valid E.164 are left untouched. Rows that
 * cannot be normalized are logged and skipped (no destructive change).
 */
import {
  db,
  applicationsTable,
  employeesTable,
  onboardingSubmissionsTable,
  usersTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";

function normalizePhoneToE164(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  const hadPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");
  if (!digits) return null;
  let candidate: string;
  if (hadPlus) candidate = `+${digits}`;
  else if (digits.length === 10) candidate = `+1${digits}`;
  else if (digits.length === 11 && digits.startsWith("1")) candidate = `+${digits}`;
  else return null;
  return /^\+\d{8,15}$/.test(candidate) ? candidate : null;
}

type Tally = { updated: number; alreadyOk: number; unparseable: number; skippedNull: number; total: number };
function emptyTally(): Tally {
  return { updated: 0, alreadyOk: 0, unparseable: 0, skippedNull: 0, total: 0 };
}
function logTally(label: string, t: Tally): void {
  // eslint-disable-next-line no-console
  console.log(
    `[${label}] total=${t.total} updated=${t.updated} alreadyE164=${t.alreadyOk} unparseable=${t.unparseable} nullOrEmpty=${t.skippedNull}`,
  );
}

async function backfillApplicationsPhone(): Promise<Tally> {
  const t = emptyTally();
  const rows = await db.select({ id: applicationsTable.id, phone: applicationsTable.phone })
    .from(applicationsTable);
  t.total = rows.length;
  for (const row of rows) {
    if (!row.phone) { t.skippedNull++; continue; }
    const normalized = normalizePhoneToE164(row.phone);
    if (!normalized) {
      t.unparseable++;
      // eslint-disable-next-line no-console
      console.warn(`[skip] applications ${row.id}: cannot normalize "${row.phone}"`);
      continue;
    }
    if (normalized === row.phone) { t.alreadyOk++; continue; }
    await db.update(applicationsTable).set({ phone: normalized }).where(eq(applicationsTable.id, row.id));
    t.updated++;
    // eslint-disable-next-line no-console
    console.log(`[ok]   applications ${row.id}: "${row.phone}" -> "${normalized}"`);
  }
  return t;
}

async function backfillApplicationReferences(): Promise<Tally> {
  const t = emptyTally();
  const rows = await db.select({ id: applicationsTable.id, references: applicationsTable.references })
    .from(applicationsTable);
  for (const row of rows) {
    const refs = row.references as Array<Record<string, unknown>> | null;
    if (!Array.isArray(refs) || refs.length === 0) { t.skippedNull++; continue; }
    let mutated = false;
    const next = refs.map((ref, idx) => {
      const raw = ref?.phone;
      t.total++;
      if (raw === undefined || raw === null || raw === "") { t.skippedNull++; return ref; }
      const normalized = normalizePhoneToE164(raw);
      if (!normalized) {
        t.unparseable++;
        // eslint-disable-next-line no-console
        console.warn(`[skip] applications ${row.id} references[${idx}]: cannot normalize "${String(raw)}"`);
        return ref;
      }
      if (normalized === raw) { t.alreadyOk++; return ref; }
      mutated = true;
      t.updated++;
      // eslint-disable-next-line no-console
      console.log(`[ok]   applications ${row.id} references[${idx}]: "${String(raw)}" -> "${normalized}"`);
      return { ...ref, phone: normalized };
    });
    if (mutated) {
      await db.update(applicationsTable).set({ references: next }).where(eq(applicationsTable.id, row.id));
    }
  }
  return t;
}

async function backfillEmployeesPhone(): Promise<Tally> {
  const t = emptyTally();
  const rows = await db.select({
    id: employeesTable.id,
    phone: employeesTable.phone,
    emergencyContactPhone: employeesTable.emergencyContactPhone,
  }).from(employeesTable);
  for (const row of rows) {
    const updates: { phone?: string; emergencyContactPhone?: string } = {};
    for (const key of ["phone", "emergencyContactPhone"] as const) {
      const raw = row[key];
      t.total++;
      if (!raw) { t.skippedNull++; continue; }
      const normalized = normalizePhoneToE164(raw);
      if (!normalized) {
        t.unparseable++;
        // eslint-disable-next-line no-console
        console.warn(`[skip] employees ${row.id}.${key}: cannot normalize "${raw}"`);
        continue;
      }
      if (normalized === raw) { t.alreadyOk++; continue; }
      updates[key] = normalized;
      t.updated++;
      // eslint-disable-next-line no-console
      console.log(`[ok]   employees ${row.id}.${key}: "${raw}" -> "${normalized}"`);
    }
    if (Object.keys(updates).length > 0) {
      await db.update(employeesTable).set(updates).where(eq(employeesTable.id, row.id));
    }
  }
  return t;
}

async function backfillOnboardingEmergencyPhone(): Promise<Tally> {
  const t = emptyTally();
  const rows = await db.select({
    id: onboardingSubmissionsTable.id,
    emergencyContactPhone: onboardingSubmissionsTable.emergencyContactPhone,
  }).from(onboardingSubmissionsTable);
  t.total = rows.length;
  for (const row of rows) {
    if (!row.emergencyContactPhone) { t.skippedNull++; continue; }
    const normalized = normalizePhoneToE164(row.emergencyContactPhone);
    if (!normalized) {
      t.unparseable++;
      // eslint-disable-next-line no-console
      console.warn(`[skip] onboarding_submissions ${row.id}.emergency_contact_phone: cannot normalize "${row.emergencyContactPhone}"`);
      continue;
    }
    if (normalized === row.emergencyContactPhone) { t.alreadyOk++; continue; }
    await db.update(onboardingSubmissionsTable)
      .set({ emergencyContactPhone: normalized })
      .where(eq(onboardingSubmissionsTable.id, row.id));
    t.updated++;
    // eslint-disable-next-line no-console
    console.log(`[ok]   onboarding_submissions ${row.id}: "${row.emergencyContactPhone}" -> "${normalized}"`);
  }
  return t;
}

async function backfillUsersPhoneNumber(): Promise<Tally> {
  const t = emptyTally();
  const rows = await db.select({ id: usersTable.id, phoneNumber: usersTable.phoneNumber })
    .from(usersTable);
  t.total = rows.length;
  for (const row of rows) {
    if (!row.phoneNumber) { t.skippedNull++; continue; }
    const normalized = normalizePhoneToE164(row.phoneNumber);
    if (!normalized) {
      t.unparseable++;
      // eslint-disable-next-line no-console
      console.warn(`[skip] users ${row.id}.phone_number: cannot normalize "${row.phoneNumber}"`);
      continue;
    }
    if (normalized === row.phoneNumber) { t.alreadyOk++; continue; }
    await db.update(usersTable).set({ phoneNumber: normalized }).where(eq(usersTable.id, row.id));
    t.updated++;
    // eslint-disable-next-line no-console
    console.log(`[ok]   users ${row.id}.phone_number: "${row.phoneNumber}" -> "${normalized}"`);
  }
  return t;
}

async function main(): Promise<void> {
  const applicationsT = await backfillApplicationsPhone();
  const referencesT = await backfillApplicationReferences();
  const employeesT = await backfillEmployeesPhone();
  const onboardingT = await backfillOnboardingEmergencyPhone();
  const usersT = await backfillUsersPhoneNumber();
  // eslint-disable-next-line no-console
  console.log("\nSummary:");
  logTally("applications.phone           ", applicationsT);
  logTally("applications.references[].phone", referencesT);
  logTally("employees.phone + emergency  ", employeesT);
  logTally("onboarding.emergency_phone   ", onboardingT);
  logTally("users.phone_number           ", usersT);
}

main().then(() => process.exit(0)).catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
