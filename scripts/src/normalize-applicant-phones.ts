/**
 * One-off backfill: normalize `applications.phone` to E.164.
 *
 * Public application submit now normalizes phone numbers on insert, but
 * pre-existing rows still hold free-text values like "(214) 555-1234" or
 * "214.555.1234". The SMS fallback on approve (sendSmsToPhoneNumber)
 * silently skips anything that isn't already valid E.164, so without this
 * backfill, historical approvals never get an SMS.
 *
 * Run with:
 *   pnpm --filter @workspace/scripts exec tsx ./src/normalize-applicant-phones.ts
 *
 * Idempotent: rows already in valid E.164 are left untouched. Rows that
 * cannot be normalized are logged and skipped (no destructive change).
 */
import { db, applicationsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

function normalizePhoneToE164(input: string): string | null {
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

async function main(): Promise<void> {
  const rows = await db.select({ id: applicationsTable.id, phone: applicationsTable.phone })
    .from(applicationsTable);
  let updated = 0;
  let alreadyOk = 0;
  let unparseable = 0;
  for (const row of rows) {
    const normalized = normalizePhoneToE164(row.phone);
    if (!normalized) {
      unparseable++;
      // eslint-disable-next-line no-console
      console.warn(`[skip] application ${row.id}: cannot normalize "${row.phone}"`);
      continue;
    }
    if (normalized === row.phone) {
      alreadyOk++;
      continue;
    }
    await db.update(applicationsTable)
      .set({ phone: normalized })
      .where(eq(applicationsTable.id, row.id));
    updated++;
    // eslint-disable-next-line no-console
    console.log(`[ok]   application ${row.id}: "${row.phone}" -> "${normalized}"`);
  }
  // eslint-disable-next-line no-console
  console.log(`\nDone. updated=${updated} alreadyE164=${alreadyOk} unparseable=${unparseable} total=${rows.length}`);
}

main().then(() => process.exit(0)).catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
