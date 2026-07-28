/**
 * One-time idempotent backfill: for draft invoices created before the
 * per-site processing fee unification, tax_amount held the per-site fee
 * while processing_fee_amount was NULL. This moves the amount to the
 * canonical column, computes the rate from the site's current salesTaxRate,
 * and zeros tax_amount.
 *
 * Conditions (all must be true to be repaired):
 *   - status = 'draft'               (never touch finalized invoices)
 *   - tax_amount > 0                 (has an old-style fee to migrate)
 *   - processing_fee_amount IS NULL  (hasn't been migrated yet)
 *
 * Idempotent: rows already migrated (processing_fee_amount IS NOT NULL)
 * or without a tax_amount are never touched.
 */
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { db, invoicesTable, sitesTable } from "@workspace/db";
import { logger } from "./logger";

export async function backfillInvoiceProcessingFees(): Promise<number> {
  // Find draft invoices that need migration.
  const candidates = await db
    .select({
      id: invoicesTable.id,
      siteId: invoicesTable.siteId,
      subtotal: invoicesTable.subtotal,
      taxAmount: invoicesTable.taxAmount,
    })
    .from(invoicesTable)
    .where(
      and(
        eq(invoicesTable.status, "draft"),
        gt(invoicesTable.taxAmount, "0"),
        isNull(invoicesTable.processingFeeAmount),
      ),
    );

  if (candidates.length === 0) return 0;

  // Fetch site rates for all affected site ids in one query.
  const siteIds = [...new Set(candidates.map((c) => c.siteId).filter(Boolean))] as string[];
  const siteRates = new Map<string, number>();
  if (siteIds.length > 0) {
    const sites = await db
      .select({ id: sitesTable.id, salesTaxRate: sitesTable.salesTaxRate })
      .from(sitesTable)
      .where(sql`${sitesTable.id} = ANY(${sql.raw(`ARRAY['${siteIds.join("','")}']::uuid[]`)})`);
    for (const s of sites) {
      siteRates.set(s.id, parseFloat(String(s.salesTaxRate ?? "8.25")));
    }
  }

  let repaired = 0;
  for (const row of candidates) {
    try {
      const feeAmount = parseFloat(String(row.taxAmount ?? "0"));
      const subtotal = parseFloat(String(row.subtotal ?? "0"));
      // Derive the rate: prefer the site's current rate; fall back to
      // back-computing from the stored amounts (subtotal > 0 guard).
      let feeRate: number | null = row.siteId ? (siteRates.get(row.siteId) ?? null) : null;
      if (feeRate === null && subtotal > 0) {
        feeRate = Math.round((feeAmount / subtotal) * 100 * 100) / 100;
      }
      await db
        .update(invoicesTable)
        .set({
          processingFeeAmount: String(Math.round(feeAmount * 100) / 100),
          processingFeeRate: feeRate !== null ? String(Math.round(feeRate * 100) / 100) : null,
          taxAmount: "0",
        })
        .where(
          and(
            eq(invoicesTable.id, row.id),
            isNull(invoicesTable.processingFeeAmount), // double-guard against races
          ),
        );
      repaired++;
    } catch (err) {
      logger.warn({ err, invoiceId: row.id }, "[invoice-fee-backfill] failed to migrate row, skipping");
    }
  }
  return repaired;
}
