import { Router, type IRouter } from "express";
import { desc, eq } from "drizzle-orm";
import { db, payrollEntriesTable, sitesTable } from "@workspace/db";
import { requireAuth } from "../middlewares/auth";

const router: IRouter = Router();

/**
 * GET /me/payroll
 *
 * Authenticated officer's pay history. Returns the caller's payroll
 * entries with site names joined in for display, sorted most recent
 * first. Officers see their own paystubs only — `employeeId` is
 * always pinned to `req.user.userId`, so this endpoint is safe even
 * if the JWT carries a non-admin role.
 */
router.get("/me/payroll", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;

  const rows = await db
    .select({
      id: payrollEntriesTable.id,
      periodStart: payrollEntriesTable.periodStart,
      periodEnd: payrollEntriesTable.periodEnd,
      totalHours: payrollEntriesTable.totalHours,
      hourlyRate: payrollEntriesTable.hourlyRate,
      grossPay: payrollEntriesTable.grossPay,
      tax: payrollEntriesTable.tax,
      netPay: payrollEntriesTable.netPay,
      status: payrollEntriesTable.status,
      paidAt: payrollEntriesTable.paidAt,
      paidMethod: payrollEntriesTable.paidMethod,
      paymentReference: payrollEntriesTable.paymentReference,
      siteId: payrollEntriesTable.siteId,
      siteName: sitesTable.name,
      createdAt: payrollEntriesTable.createdAt,
    })
    .from(payrollEntriesTable)
    .leftJoin(sitesTable, eq(sitesTable.id, payrollEntriesTable.siteId))
    .where(eq(payrollEntriesTable.employeeId, userId))
    .orderBy(desc(payrollEntriesTable.periodStart));

  // 1099 contractors — no tax is withheld; net always equals gross. Normalise on
  // read so any legacy row stored with withholding still shows full gross to the
  // officer (rows + YTD/lifetime totals).
  const normalized = rows.map((r) => ({ ...r, tax: "0", netPay: r.grossPay }));

  // Aggregate year-to-date and lifetime totals so the officer screen
  // can show a quick summary header without needing a second request.
  const yearStart = new Date(new Date().getUTCFullYear(), 0, 1).toISOString().slice(0, 10);
  let ytdGross = 0;
  let ytdNet = 0;
  let lifetimeNet = 0;
  for (const r of normalized) {
    const gross = Number(r.grossPay);
    const net = Number(r.netPay);
    if (Number.isFinite(net)) lifetimeNet += net;
    if (r.periodStart >= yearStart) {
      if (Number.isFinite(gross)) ytdGross += gross;
      if (Number.isFinite(net)) ytdNet += net;
    }
  }

  res.json({
    rows: normalized,
    summary: {
      ytdGross: ytdGross.toFixed(2),
      ytdNet: ytdNet.toFixed(2),
      lifetimeNet: lifetimeNet.toFixed(2),
      count: rows.length,
    },
  });
});

export default router;
