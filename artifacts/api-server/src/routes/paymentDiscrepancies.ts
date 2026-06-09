import { Router, type IRouter } from "express";
import { eq, desc } from "drizzle-orm";
import { db, paymentDiscrepanciesTable, usersTable, type PaymentDiscrepancy } from "@workspace/db";
import { CreatePaymentDiscrepancyBody } from "@workspace/api-zod";
import { requireAuth } from "../middlewares/auth";
import { sendEmail, renderPaymentDiscrepancyEmail } from "../lib/email";
import { brand } from "../lib/brandConfig";

const router: IRouter = Router();

function appBaseUrl(): string | null {
  if (process.env.APP_BASE_URL) return process.env.APP_BASE_URL.replace(/\/+$/, "");
  const domains = process.env.REPLIT_DOMAINS;
  if (domains) return `https://${domains.split(",")[0]!.trim()}`;
  return null;
}

// pg `date` columns round-trip as "YYYY-MM-DD" strings; the generated zod body
// coerces incoming ISO date strings to Date objects, so convert back before
// inserting (UTC slice keeps the calendar day the officer picked).
const toDateStr = (d: Date | null | undefined): string | null =>
  d ? d.toISOString().slice(0, 10) : null;

function rowToDto(r: PaymentDiscrepancy) {
  return {
    id: r.id,
    employeeId: r.employeeId,
    discrepancyType: r.discrepancyType,
    payPeriodStart: r.payPeriodStart,
    payPeriodEnd: r.payPeriodEnd,
    shiftDate: r.shiftDate,
    expectedAmount: r.expectedAmount,
    receivedAmount: r.receivedAmount,
    description: r.description,
    status: r.status,
    adminNotes: r.adminNotes,
    resolvedAt: r.resolvedAt ? r.resolvedAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

// Internal staff/officers (admin, dispatcher, employee, lead) only — external
// `client` portal accounts are not paid by us and cannot file pay discrepancies.
function rejectClient(req: { user?: { role: string } }): boolean {
  return req.user?.role === "client";
}

router.post("/payment-discrepancies", requireAuth, async (req, res): Promise<void> => {
  if (rejectClient(req)) {
    res.status(403).json({ error: "Forbidden", message: "Not available for client accounts" });
    return;
  }
  const parsed = CreatePaymentDiscrepancyBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Bad Request", message: parsed.error.message });
    return;
  }
  const d = parsed.data;
  const [row] = await db
    .insert(paymentDiscrepanciesTable)
    .values({
      employeeId: req.user!.userId,
      discrepancyType: d.discrepancyType,
      payPeriodStart: toDateStr(d.payPeriodStart),
      payPeriodEnd: toDateStr(d.payPeriodEnd),
      shiftDate: toDateStr(d.shiftDate),
      expectedAmount: d.expectedAmount != null ? String(d.expectedAmount) : null,
      receivedAmount: d.receivedAmount != null ? String(d.receivedAmount) : null,
      description: d.description,
    })
    .returning();

  // Fire-and-forget admin notification to the dedicated HR/admin inbox so the
  // submit response is never blocked on mail delivery.
  void (async () => {
    try {
      const [officer] = await db
        .select({ firstName: usersTable.firstName, lastName: usersTable.lastName, email: usersTable.email })
        .from(usersTable)
        .where(eq(usersTable.id, req.user!.userId))
        .limit(1);
      const officerName =
        (officer ? `${officer.firstName ?? ""} ${officer.lastName ?? ""}`.trim() : "") ||
        officer?.email ||
        req.user!.email;
      const base = appBaseUrl();
      const payPeriod = row!.payPeriodStart
        ? `${row!.payPeriodStart}${row!.payPeriodEnd ? ` – ${row!.payPeriodEnd}` : ""}`
        : undefined;
      const tmpl = renderPaymentDiscrepancyEmail({
        officerName,
        officerEmail: officer?.email ?? req.user!.email,
        discrepancyType: d.discrepancyType,
        payPeriod,
        shiftDate: row!.shiftDate ?? undefined,
        expectedAmount: row!.expectedAmount ?? undefined,
        receivedAmount: row!.receivedAmount ?? undefined,
        description: row!.description,
        reviewUrl: base ? `${base}/admin-portal/tables/payment_discrepancies` : undefined,
      });
      await sendEmail({ to: brand.adminNotifyEmail, subject: tmpl.subject, text: tmpl.text, html: tmpl.html });
    } catch (err) {
      req.log.warn({ err, discrepancyId: row!.id }, "payment discrepancy admin email failed");
    }
  })();

  res.status(201).json(rowToDto(row!));
});

router.get("/me/payment-discrepancies", requireAuth, async (req, res): Promise<void> => {
  if (rejectClient(req)) {
    res.status(403).json({ error: "Forbidden", message: "Not available for client accounts" });
    return;
  }
  const rows = await db
    .select()
    .from(paymentDiscrepanciesTable)
    .where(eq(paymentDiscrepanciesTable.employeeId, req.user!.userId))
    .orderBy(desc(paymentDiscrepanciesTable.createdAt));
  res.json(rows.map(rowToDto));
});

export default router;
